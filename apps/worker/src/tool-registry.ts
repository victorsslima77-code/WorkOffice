import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentEventType, DeskSlot, LlmProvider, RoleSlug } from '@workoffice/shared';
import {
  fetchShortAnalyticsSnapshot,
  uploadShortToYoutubeChannel,
  type YoutubeOAuthCredentials,
  type YoutubeUploadedShortResult,
} from './tools/publisher-youtube-tools.js';
import {
  extractBestTranscriptWindowForShort,
  listChannelOrTopicVideos,
  searchTrendingTopicsForScriptwriter,
  type AudiencePeakMoment,
  type CandidatePodcastVideo,
} from './tools/scriptwriter-tools.js';
import {
  downloadVideoSegmentToFile,
  extractSpokenSubtitlesFromClip,
  formatCuesToSrt,
  renderShortVideoPackage,
  type EditorSubtitleStyle,
  type SpokenSubtitleCue,
} from './tools/video-editor-tools.js';

export class ToolPermissionError extends Error {
  constructor(roleSlug: string, toolName: string) {
    super(`O cargo "${roleSlug}" nao tem permissao para executar a ferramenta "${toolName}".`);
    this.name = 'ToolPermissionError';
  }
}

export interface ToolExecutionContext {
  officeId: string;
  runId: string;
  taskId: string;
  agentId: string;
  roleSlug: RoleSlug;
  allowedTools: readonly string[];
  videoIndex: number;
  totalVideos: number;
  instruction: string;
  sourceUrl?: string;
  sourceVideoTitle?: string;
  sourceChannelName?: string;
  sourceDurationSec?: number;
  candidateVideos?: CandidatePodcastVideo[];
  /** Picos reais de audiencia ("Most Replayed") extraidos do grafico de retencao do YouTube */
  audiencePeaks?: AudiencePeakMoment[];
  /** Origem dos dados de pico de audiencia */
  heatmapSource?: string;
  transcriptText?: string;
  /** Instrucoes de edicao do roteirista (rationale) — usadas apenas para guiar estilo/ritmo, NUNCA como texto de legenda! */
  editingInstructions?: string;
  /** Idioma original falado detectado no video (ex: "pt", "en") — preservado estritamente nas legendas */
  detectedVideoLanguage?: string;
  /** Falas reais transcritas do video com timestamps relativos ao corte (0..duracao) */
  spokenSubtitleCues?: SpokenSubtitleCue[];
  /** Origem da transcricao real das falas */
  subtitleSource?: string;
  /** Estilo visual das legendas/corte derivado exclusivamente da fala real */
  subtitleStyle?: EditorSubtitleStyle;
  /** Offset em segundos para capturar o frame da thumbnail */
  thumbnailOffsetSec?: number;
  /** Caminho no Supabase Storage (bucket shorts) da thumbnail JPEG capturada pelo Editor */
  thumbnailPath?: string;
  /** Buffer JPEG da thumbnail capturada em memoria */
  thumbnailBuffer?: Buffer;
  /** Duracao final em segundos do Short apos corte de pausas silenciosas e transicoes */
  renderedDurationSec?: number;
  /** Caminho temporario local do trecho baixado pelo yt-dlp para reutilizacao entre transcricao e ffmpeg */
  downloadedClipPath?: string;
  /** Diretorio temporario de trabalho do clipe (limpo ao final da task) */
  tempWorkDir?: string;
  llmProvider?: LlmProvider;
  llmApiKey?: string;
  suggestedTitle?: string;
  seoDescription?: string;
  seoTags?: string[];
  hookText?: string;
  startSec?: number;
  endSec?: number;
  youtubeOAuth?: YoutubeOAuthCredentials | null;
  supabaseStorageClient?: SupabaseClient | null;
  lastUploadedShort?: YoutubeUploadedShortResult | null;
  isSandbox?: boolean;
  abortSignal?: AbortSignal;
  emitVisualEvent: (params: {
    type: AgentEventType;
    message: string;
    progress?: number;
    targetDeskSlot?: DeskSlot;
    toolName?: string;
  }) => Promise<void>;
}

export interface RegisteredAgentTool {
  name: string;
  description: string;
  visualEventType: AgentEventType;
  defaultProgress: number;
  execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<unknown>;
}

export const WORKER_TOOL_CATALOG: Record<string, RegisteredAgentTool> = {
  // 1. Ferramentas Reais do Roteirista / Pesquisador (scriptwriter)
  web_search: {
    name: 'web_search',
    description: 'Pesquisa topicos em alta sobre o tema solicitado pelo usuario.',
    visualEventType: 'research.web_search',
    defaultProgress: 25,
    async execute(args, ctx) {
      const query = String(args.query ?? ctx.instruction);
      await ctx.emitVisualEvent({
        type: 'research.web_search',
        toolName: 'web_search',
        progress: 25,
        message: `Pesquisando tendências para Vídeo #${ctx.videoIndex}/${ctx.totalVideos}: "${query}"`,
      });
      return searchTrendingTopicsForScriptwriter(query, ctx.videoIndex, ctx.youtubeOAuth, {
        allowSandboxFallback: Boolean(ctx.isSandbox),
      });
    },
  },

  youtube_list_videos: {
    name: 'youtube_list_videos',
    description: 'Lista episodios e videos recentes relacionados ao tema com validacao SSRF.',
    visualEventType: 'research.web_search',
    defaultProgress: 45,
    async execute(args, ctx) {
      const channelUrl = String(args.channel_url ?? 'https://www.youtube.com/@podcast');
      await ctx.emitVisualEvent({
        type: 'research.web_search',
        toolName: 'youtube_list_videos',
        progress: 45,
        message: `Buscando vídeos reais no YouTube sobre "${ctx.instruction}" (Vídeo #${ctx.videoIndex}/${ctx.totalVideos})`,
      });
      const videos = await listChannelOrTopicVideos(
        channelUrl,
        ctx.instruction,
        ctx.videoIndex,
        ctx.youtubeOAuth,
        { allowSandboxFallback: Boolean(ctx.isSandbox) },
      );
      ctx.candidateVideos = videos;
      if (videos[0]) {
        ctx.sourceUrl = videos[0].url;
        ctx.sourceVideoTitle = videos[0].title;
        ctx.sourceChannelName = videos[0].channelTitle;
        ctx.sourceDurationSec = videos[0].durationSec;
      }
      return { videos };
    },
  },

  fetch_transcript: {
    name: 'fetch_transcript',
    description: 'Extrai a janela de transcricao <= 60s com timestamps do video selecionado.',
    visualEventType: 'research.read_source',
    defaultProgress: 65,
    async execute(args, ctx) {
      const candidateUrl = args.source_url ? String(args.source_url) : ctx.sourceUrl;
      if (!candidateUrl && !ctx.isSandbox) {
        throw new Error(
          `Roteirista não encontrou nenhuma URL real do YouTube para extrair contexto (Vídeo #${ctx.videoIndex}).`,
        );
      }
      const sourceUrl =
        candidateUrl ?? `https://www.youtube.com/watch?v=source_${String(ctx.videoIndex).padStart(2, '0')}`;
      await ctx.emitVisualEvent({
        type: 'research.read_source',
        toolName: 'fetch_transcript',
        progress: 65,
        message: `Extraindo contexto e timestamps de "${ctx.sourceVideoTitle ?? sourceUrl}" (Vídeo #${ctx.videoIndex}/${ctx.totalVideos})`,
      });
      const transcript = await extractBestTranscriptWindowForShort(
        sourceUrl,
        ctx.instruction,
        ctx.videoIndex,
        {
          title: ctx.sourceVideoTitle,
          channelTitle: ctx.sourceChannelName,
          durationSec: ctx.sourceDurationSec,
        },
      );
      ctx.sourceUrl = sourceUrl;
      ctx.startSec = transcript.startSec;
      ctx.endSec = transcript.endSec;
      ctx.transcriptText = transcript.transcriptText;
      ctx.suggestedTitle = transcript.suggestedTitle;
      ctx.hookText = transcript.hook;
      ctx.audiencePeaks = transcript.audiencePeaks;
      ctx.heatmapSource = transcript.heatmapSource;
      if (transcript.resolvedDurationSec) {
        ctx.sourceDurationSec = transcript.resolvedDurationSec;
      }

      if (transcript.audiencePeaks.length > 0) {
        const mainPeak = transcript.audiencePeaks[0]!;
        await ctx.emitVisualEvent({
          type: 'research.read_source',
          toolName: 'fetch_transcript',
          progress: 72,
          message: `Pico de audiência detectado em ${mainPeak.peakFormatted} (${Math.round(mainPeak.intensity * 100)}% Most Replayed) — corte ancorado em ${mainPeak.recommendedStartSec}s–${mainPeak.recommendedEndSec}s`,
        });
      }
      return transcript;
    },
  },

  read_source: {
    name: 'read_source',
    description: 'Le notas e referencias complementares na estante da baia.',
    visualEventType: 'research.read_source',
    defaultProgress: 80,
    async execute(_args, ctx) {
      await ctx.emitVisualEvent({
        type: 'research.read_source',
        toolName: 'read_source',
        progress: 80,
        message: `Consultando referências na estante para o Vídeo #${ctx.videoIndex}/${ctx.totalVideos}`,
      });
      return { summary: `Referência validada para corte #${ctx.videoIndex}` };
    },
  },

  // 2. Ferramentas Reais do Editor de Video (video_editor)
  download_video_segment: {
    name: 'download_video_segment',
    description: 'Valida URL contra SSRF e baixa exclusivamente o segmento selecionado via yt-dlp.',
    visualEventType: 'edit.download',
    defaultProgress: 25,
    async execute(args, ctx) {
      const candidateUrl = args.source_url ? String(args.source_url) : ctx.sourceUrl;
      if (!candidateUrl && !ctx.isSandbox) {
        throw new Error(
          `Editor não recebeu nenhuma URL real de vídeo do Roteirista para o Vídeo #${ctx.videoIndex}.`,
        );
      }
      const sourceUrl = candidateUrl ?? 'https://www.youtube.com/watch?v=demo';
      const startSec = ctx.startSec ?? 0;
      const endSec = ctx.endSec ?? Math.min(startSec + 45, 60);

      await ctx.emitVisualEvent({
        type: 'edit.download',
        toolName: 'download_video_segment',
        progress: 25,
        message: `Baixando trecho bruto (${startSec}s–${endSec}s) do Vídeo #${ctx.videoIndex}/${ctx.totalVideos} (${sourceUrl})`,
      });

      if (!ctx.tempWorkDir) {
        ctx.tempWorkDir = await fs.mkdtemp(
          path.join(os.tmpdir(), `wo-edit-${ctx.taskId.slice(0, 8)}-`),
        );
      }
      const vPad = String(ctx.videoIndex).padStart(2, '0');
      const rawClipPath = path.join(ctx.tempWorkDir, `raw_${vPad}.mp4`);

      if (process.env.ENABLE_NATIVE_FFMPEG === 'true' && !ctx.isSandbox) {
        const dl = await downloadVideoSegmentToFile({
          sourceUrl,
          startSec,
          endSec,
          outputPath: rawClipPath,
        });
        if (dl.ok) {
          ctx.downloadedClipPath = rawClipPath;
        } else if (process.env.ALLOW_SYNTHETIC_VIDEO_FALLBACK !== 'true') {
          throw new Error(
            `Editor falhou ao baixar o vídeo real (${sourceUrl}) via yt-dlp: ${dl.reason ?? 'erro desconhecido'}`,
          );
        }
      }

      return { local_raw_path: ctx.downloadedClipPath ?? rawClipPath, source_url: sourceUrl };
    },
  },

  transcribe_audio: {
    name: 'transcribe_audio',
    description:
      'Transcreve a fala real do video mantendo obrigatoriamente o idioma original (PT->PT, EN->EN) sem traduzir e sem inserir instrucoes do roteirista.',
    visualEventType: 'edit.subtitle',
    defaultProgress: 50,
    async execute(_args, ctx) {
      const vPad = String(ctx.videoIndex).padStart(2, '0');
      const startSec = ctx.startSec ?? 0;
      const endSec = ctx.endSec ?? Math.min(startSec + 45, 60);
      const sourceUrl = ctx.sourceUrl ?? 'https://www.youtube.com/watch?v=demo';

      if (!ctx.tempWorkDir) {
        ctx.tempWorkDir = await fs.mkdtemp(
          path.join(os.tmpdir(), `wo-edit-${ctx.taskId.slice(0, 8)}-`),
        );
      }

      const extracted = await extractSpokenSubtitlesFromClip({
        sourceUrl,
        startSec,
        endSec,
        rawClipPath: ctx.downloadedClipPath,
        workDir: ctx.tempWorkDir,
        provider: ctx.llmProvider,
        apiKey: ctx.llmApiKey,
        isSandbox: Boolean(ctx.isSandbox),
      });

      ctx.detectedVideoLanguage = extracted.language;
      ctx.spokenSubtitleCues = extracted.cues;
      ctx.subtitleSource = extracted.source;

      const srt = formatCuesToSrt(extracted.cues);
      await ctx.emitVisualEvent({
        type: 'edit.subtitle',
        toolName: 'transcribe_audio',
        progress: 50,
        message:
          extracted.cues.length > 0
            ? `Fala real transcrita (${extracted.cues.length} legendas no idioma original "${extracted.language}" via ${extracted.source}) para o Vídeo #${ctx.videoIndex}/${ctx.totalVideos}`
            : `Nenhuma fala detectada para legendar no trecho (${extracted.language}); mantendo vídeo limpo sem inserir instruções do roteirista.`,
      });

      return {
        subtitle_path: `${ctx.officeId}/${ctx.runId}/short_${vPad}.srt`,
        detected_language: extracted.language,
        subtitle_source: extracted.source,
        cues_count: extracted.cues.length,
        srt_content: srt,
      };
    },
  },

  cut_vertical_short: {
    name: 'cut_vertical_short',
    description: 'Corta e reenquadra o video para formato vertical 9:16 (1080x1920, <=60s).',
    visualEventType: 'edit.cut',
    defaultProgress: 75,
    async execute(_args, ctx) {
      const startSec = ctx.startSec ?? 0;
      const endSec = ctx.endSec ?? 45;
      const dur = Math.max(1, Math.min(60, endSec - startSec));
      await ctx.emitVisualEvent({
        type: 'edit.cut',
        toolName: 'cut_vertical_short',
        progress: 75,
        message: `Cortando Vídeo #${ctx.videoIndex}/${ctx.totalVideos} em 9:16 vertical (1080x1920 • ${dur}s) com ffmpeg`,
      });
      return { duration_sec: dur, resolution: '1080x1920' };
    },
  },

  burn_subtitles: {
    name: 'burn_subtitles',
    description: 'Renderiza o burn-in das legendas estilizadas da fala real no video vertical.',
    visualEventType: 'edit.render',
    defaultProgress: 90,
    async execute(_args, ctx) {
      const lang = ctx.detectedVideoLanguage ?? 'original';
      const count = ctx.spokenSubtitleCues?.length ?? 0;
      await ctx.emitVisualEvent({
        type: 'edit.render',
        toolName: 'burn_subtitles',
        progress: 90,
        message:
          count > 0
            ? `Aplicando burn-in de ${count} legendas da fala real (idioma "${lang}") no Vídeo #${ctx.videoIndex}/${ctx.totalVideos}`
            : `Renderizando Vídeo #${ctx.videoIndex}/${ctx.totalVideos} em 9:16 (sem legendas sintéticas)`,
      });
      return { rendered: true, cues_count: count, language: lang };
    },
  },

  upload_artifact: {
    name: 'upload_artifact',
    description: 'Gera o pacote MP4 vertical + SRT da fala real e envia para os buckets privados no Supabase Storage.',
    visualEventType: 'edit.render',
    defaultProgress: 100,
    async execute(_args, ctx) {
      const startSec = ctx.startSec ?? 60;
      const endSec = ctx.endSec ?? 112;
      if (!ctx.sourceUrl && !ctx.isSandbox) {
        throw new Error(
          `Editor não recebeu nenhuma URL real de vídeo para renderizar o Vídeo #${ctx.videoIndex}.`,
        );
      }
      const sourceUrl = ctx.sourceUrl ?? 'https://www.youtube.com/watch?v=demo';

      const pkg = await renderShortVideoPackage({
        officeId: ctx.officeId,
        runId: ctx.runId,
        taskId: ctx.taskId,
        videoIndex: ctx.videoIndex,
        sourceUrl,
        startSec,
        endSec,
        hookText: ctx.hookText ?? '',
        bodyText: '',
        spokenCues: ctx.spokenSubtitleCues,
        subtitleStyle: ctx.subtitleStyle,
        thumbnailOffsetSec: ctx.thumbnailOffsetSec,
        preDownloadedRawClipPath: ctx.downloadedClipPath,
        supabaseStorageClient: ctx.supabaseStorageClient,
        allowSyntheticFallback: Boolean(ctx.isSandbox),
      });

      ctx.thumbnailPath = pkg.storageThumbnailPath;
      ctx.thumbnailBuffer = pkg.thumbnailBuffer;
      ctx.renderedDurationSec = pkg.durationSec;

      await ctx.emitVisualEvent({
        type: 'edit.render',
        toolName: 'upload_artifact',
        progress: 100,
        message: `Short #${ctx.videoIndex}/${ctx.totalVideos} renderizado (${pkg.durationSec}s • ${pkg.silencesCutCount} pausas cortadas • ${pkg.editSegmentsCount} segmentos com transição "${pkg.cutTransition}" • ${pkg.subtitleCuesCount} legendas ASS animadas em "${ctx.detectedVideoLanguage ?? 'original'}" • thumbnail capturada) e salvo no Storage (${pkg.storageVideoPath})`,
      });

      return {
        storage_path: pkg.storageVideoPath,
        subtitle_path: pkg.storageSubtitlePath,
        thumbnail_path: pkg.storageThumbnailPath,
        duration_sec: pkg.durationSec,
        resolution: pkg.resolution,
        byte_size: pkg.mp4Buffer.byteLength,
        thumbnail_byte_size: pkg.thumbnailBuffer.byteLength,
        detected_language: ctx.detectedVideoLanguage ?? 'unknown',
        subtitle_source: ctx.subtitleSource ?? 'none',
        subtitle_cues_count: pkg.subtitleCuesCount,
        silences_cut_count: pkg.silencesCutCount,
        edit_segments_count: pkg.editSegmentsCount,
        cut_transition: pkg.cutTransition,
      };
    },
  },

  // 3. Ferramentas Reais do Publicador / Analista (publisher_analyst)
  youtube_upload_short: {
    name: 'youtube_upload_short',
    description:
      'Verifica a cota diaria (max 6 videos/dia na YouTube Data API v3) e faz upload do Short ou reserva slot de agendamento.',
    visualEventType: 'publish.upload',
    defaultProgress: 50,
    async execute(_args, ctx) {
      const cleanTitle =
        ctx.suggestedTitle?.trim() || `Corte em Destaque #${ctx.videoIndex} #shorts`;
      const seoTags =
        ctx.seoTags && ctx.seoTags.length > 0
          ? ctx.seoTags
          : ['shorts', 'youtube shorts', 'cortes', 'viral'];
      const hashtagsStr = seoTags
        .slice(0, 5)
        .map((t) => `#${t.replace(/[^a-zA-Z0-9À-ÿ]/g, '')}`)
        .filter((h) => h.length > 1)
        .join(' ');
      const seoDescription =
        ctx.seoDescription?.trim() ||
        [
          ctx.hookText?.trim() || cleanTitle.replace(/\s*#shorts/gi, '').trim(),
          '',
          'Curtiu esse corte? Deixe o like, comente sua opinião e inscreva-se no canal para não perder os próximos Shorts!',
          '',
          `${hashtagsStr} #shorts`.trim(),
        ].join('\n');

      const uploaded = await uploadShortToYoutubeChannel({
        officeId: ctx.officeId,
        runId: ctx.runId,
        videoIndex: ctx.videoIndex,
        title: cleanTitle,
        description: seoDescription,
        tags: seoTags,
        visibility: 'public',
        thumbnailPath: ctx.thumbnailPath,
        thumbnailBuffer: ctx.thumbnailBuffer,
        oauth: ctx.youtubeOAuth,
        supabaseStorageClient: ctx.supabaseStorageClient,
        allowSandboxFallback: Boolean(ctx.isSandbox),
      });

      ctx.lastUploadedShort = uploaded;

      await ctx.emitVisualEvent({
        type: 'publish.upload',
        toolName: 'youtube_upload_short',
        progress: 50,
        message:
          uploaded.publicationStatus === 'published'
            ? `Short #${ctx.videoIndex}/${ctx.totalVideos} publicado como ${uploaded.visibility.toUpperCase()} (${uploaded.tags.length} tags SEO • ${uploaded.thumbnailApplied ? 'thumbnail aplicada' : 'thumbnail salva'} • ${uploaded.mode}): ${uploaded.url}`
            : `Cota diária (6/dia) atingida! Short #${ctx.videoIndex}/${ctx.totalVideos} agendado: ${uploaded.outputSummary}`,
      });

      return uploaded;
    },
  },

  youtube_schedule_video: {
    name: 'youtube_schedule_video',
    description:
      'Mantem a periodicidade maxima (a cada 4h, max 6/dia) e agenda a publicacao quando a producao excede a cota diaria.',
    visualEventType: 'publish.upload',
    defaultProgress: 75,
    async execute(_args, ctx) {
      const cleanTitle =
        ctx.suggestedTitle?.trim() || `Corte em Destaque #${ctx.videoIndex} #shorts`;
      const seoTags =
        ctx.seoTags && ctx.seoTags.length > 0
          ? ctx.seoTags
          : ['shorts', 'youtube shorts', 'cortes', 'viral'];
      const hashtagsStr = seoTags
        .slice(0, 5)
        .map((t) => `#${t.replace(/[^a-zA-Z0-9À-ÿ]/g, '')}`)
        .filter((h) => h.length > 1)
        .join(' ');
      const seoDescription =
        ctx.seoDescription?.trim() ||
        `${ctx.hookText?.trim() || cleanTitle.replace(/\s*#shorts/gi, '').trim()}\n\nCurtiu o corte? Deixe o like e inscreva-se!\n\n${hashtagsStr} #shorts`;

      const uploaded =
        ctx.lastUploadedShort ??
        (await uploadShortToYoutubeChannel({
          officeId: ctx.officeId,
          runId: ctx.runId,
          videoIndex: ctx.videoIndex,
          title: cleanTitle,
          description: seoDescription,
          tags: seoTags,
          visibility: 'public',
          thumbnailPath: ctx.thumbnailPath,
          thumbnailBuffer: ctx.thumbnailBuffer,
          oauth: ctx.youtubeOAuth,
          supabaseStorageClient: ctx.supabaseStorageClient,
          allowSandboxFallback: Boolean(ctx.isSandbox),
        }));

      ctx.lastUploadedShort = uploaded;

      await ctx.emitVisualEvent({
        type: 'publish.upload',
        toolName: 'youtube_schedule_video',
        progress: 75,
        message: uploaded.outputSummary,
      });
      return {
        publication_status: uploaded.publicationStatus,
        scheduled_at: uploaded.scheduledAt,
        visibility: uploaded.visibility,
        description: uploaded.description,
        tags: uploaded.tags,
        schedule_details: uploaded.scheduleDetails,
        output_summary: uploaded.outputSummary,
      };
    },
  },

  youtube_fetch_analytics: {
    name: 'youtube_fetch_analytics',
    description: 'Coleta metricas de visualizacoes, likes, comentarios e retencao na YouTube Analytics API.',
    visualEventType: 'metrics.check',
    defaultProgress: 95,
    async execute(args, ctx) {
      const vPad = String(ctx.videoIndex).padStart(2, '0');
      const ytId = String(
        ctx.lastUploadedShort?.youtubeVideoId ??
          args.youtube_video_id ??
          `yt_${ctx.runId.slice(0, 6)}_${vPad}`,
      );
      const snapshot = await fetchShortAnalyticsSnapshot({
        youtubeVideoId: ytId,
        videoIndex: ctx.videoIndex,
        oauth: ctx.youtubeOAuth,
      });

      await ctx.emitVisualEvent({
        type: 'metrics.check',
        toolName: 'youtube_fetch_analytics',
        progress: 95,
        message: `Métricas do Vídeo #${ctx.videoIndex}/${ctx.totalVideos} (${ytId}): ${snapshot.views} views • ${snapshot.retention}% retenção`,
      });

      return snapshot;
    },
  },
};

export async function executeRegisteredTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<unknown> {
  if (ctx.abortSignal?.aborted) {
    throw new Error('Execucao abortada pelo usuario (mandado descansar).');
  }

  if (!ctx.allowedTools.includes(toolName)) {
    throw new ToolPermissionError(ctx.roleSlug, toolName);
  }

  const toolDef = WORKER_TOOL_CATALOG[toolName];
  if (!toolDef) {
    throw new Error(`Ferramenta desconhecida no Tool Registry: "${toolName}"`);
  }

  return toolDef.execute(args, ctx);
}
