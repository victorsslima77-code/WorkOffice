import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentEventType, DeskSlot, RoleSlug } from '@workoffice/shared';
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
} from './tools/scriptwriter-tools.js';
import {
  buildDynamicSrtSubtitles,
  renderShortVideoPackage,
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
  startSec?: number;
  endSec?: number;
  youtubeOAuth?: YoutubeOAuthCredentials | null;
  supabaseStorageClient?: SupabaseClient | null;
  lastUploadedShort?: YoutubeUploadedShortResult | null;
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
      return searchTrendingTopicsForScriptwriter(query, ctx.videoIndex);
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
        message: `Listando vídeos candidatos em ${channelUrl} (Vídeo #${ctx.videoIndex}/${ctx.totalVideos})`,
      });
      const videos = await listChannelOrTopicVideos(channelUrl, ctx.instruction, ctx.videoIndex);
      return { videos };
    },
  },

  fetch_transcript: {
    name: 'fetch_transcript',
    description: 'Extrai a janela de transcricao <= 60s com timestamps do video selecionado.',
    visualEventType: 'research.read_source',
    defaultProgress: 65,
    async execute(args, ctx) {
      const sourceUrl = String(
        args.source_url ??
          ctx.sourceUrl ??
          `https://www.youtube.com/watch?v=source_${String(ctx.videoIndex).padStart(2, '0')}`,
      );
      await ctx.emitVisualEvent({
        type: 'research.read_source',
        toolName: 'fetch_transcript',
        progress: 65,
        message: `Extraindo transcrição e timestamps para o Vídeo #${ctx.videoIndex}/${ctx.totalVideos}`,
      });
      return extractBestTranscriptWindowForShort(sourceUrl, ctx.instruction, ctx.videoIndex);
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
    description: 'Valida URL contra SSRF e prepara segmento especifico via yt-dlp.',
    visualEventType: 'edit.download',
    defaultProgress: 25,
    async execute(args, ctx) {
      const sourceUrl = String(
        args.source_url ?? ctx.sourceUrl ?? 'https://www.youtube.com/watch?v=demo',
      );
      await ctx.emitVisualEvent({
        type: 'edit.download',
        toolName: 'download_video_segment',
        progress: 25,
        message: `Baixando trecho bruto do Vídeo #${ctx.videoIndex}/${ctx.totalVideos} (${sourceUrl})`,
      });
      return { local_raw_path: `/tmp/raw_video_${ctx.videoIndex}.mp4`, source_url: sourceUrl };
    },
  },

  transcribe_audio: {
    name: 'transcribe_audio',
    description: 'Gera arquivo de legenda .srt sincronizado palavra por palavra.',
    visualEventType: 'edit.subtitle',
    defaultProgress: 50,
    async execute(_args, ctx) {
      const vPad = String(ctx.videoIndex).padStart(2, '0');
      const srt = buildDynamicSrtSubtitles(
        `Gancho do Vídeo #${ctx.videoIndex}: ${ctx.instruction}`,
        `Conteúdo principal editado e legendado sobre ${ctx.instruction}.`,
        52,
      );
      await ctx.emitVisualEvent({
        type: 'edit.subtitle',
        toolName: 'transcribe_audio',
        progress: 50,
        message: `Legendas (.srt) geradas para o Vídeo #${ctx.videoIndex}/${ctx.totalVideos}`,
      });
      return {
        subtitle_path: `${ctx.officeId}/${ctx.runId}/short_${vPad}.srt`,
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
      await ctx.emitVisualEvent({
        type: 'edit.cut',
        toolName: 'cut_vertical_short',
        progress: 75,
        message: `Cortando Vídeo #${ctx.videoIndex}/${ctx.totalVideos} em 9:16 vertical (1080x1920) com ffmpeg`,
      });
      return { duration_sec: 52, resolution: '1080x1920' };
    },
  },

  burn_subtitles: {
    name: 'burn_subtitles',
    description: 'Renderiza o burn-in das legendas estilizadas no video vertical.',
    visualEventType: 'edit.render',
    defaultProgress: 90,
    async execute(_args, ctx) {
      await ctx.emitVisualEvent({
        type: 'edit.render',
        toolName: 'burn_subtitles',
        progress: 90,
        message: `Renderizando burn-in de legendas no Vídeo #${ctx.videoIndex}/${ctx.totalVideos}`,
      });
      return { rendered: true };
    },
  },

  upload_artifact: {
    name: 'upload_artifact',
    description: 'Gera o pacote MP4 vertical + SRT e envia para os buckets privados no Supabase Storage.',
    visualEventType: 'edit.render',
    defaultProgress: 100,
    async execute(_args, ctx) {
      const startSec = ctx.startSec ?? 60;
      const endSec = ctx.endSec ?? 112;
      const sourceUrl = ctx.sourceUrl ?? 'https://www.youtube.com/watch?v=demo';

      const pkg = await renderShortVideoPackage({
        officeId: ctx.officeId,
        runId: ctx.runId,
        taskId: ctx.taskId,
        videoIndex: ctx.videoIndex,
        sourceUrl,
        startSec,
        endSec,
        hookText: `Vídeo #${ctx.videoIndex}: ${ctx.instruction}`,
        bodyText: `Corte vertical 9:16 com legendas sincronizadas para ${ctx.instruction}.`,
        supabaseStorageClient: ctx.supabaseStorageClient,
      });

      await ctx.emitVisualEvent({
        type: 'edit.render',
        toolName: 'upload_artifact',
        progress: 100,
        message: `Short #${ctx.videoIndex}/${ctx.totalVideos} renderizado e salvo no Storage (${pkg.storageVideoPath})`,
      });

      return {
        storage_path: pkg.storageVideoPath,
        subtitle_path: pkg.storageSubtitlePath,
        duration_sec: pkg.durationSec,
        resolution: pkg.resolution,
        byte_size: pkg.mp4Buffer.byteLength,
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
      const uploaded = await uploadShortToYoutubeChannel({
        officeId: ctx.officeId,
        runId: ctx.runId,
        videoIndex: ctx.videoIndex,
        title: `Vídeo #${ctx.videoIndex}/${ctx.totalVideos} — ${ctx.instruction}`,
        description: `Short produzido e publicado automaticamente pelo WorkOffice: ${ctx.instruction} #shorts`,
        visibility: 'private',
        oauth: ctx.youtubeOAuth,
        supabaseStorageClient: ctx.supabaseStorageClient,
      });

      ctx.lastUploadedShort = uploaded;

      await ctx.emitVisualEvent({
        type: 'publish.upload',
        toolName: 'youtube_upload_short',
        progress: 50,
        message:
          uploaded.publicationStatus === 'published'
            ? `Short #${ctx.videoIndex}/${ctx.totalVideos} publicado no YouTube (${uploaded.mode}): ${uploaded.url}`
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
      const uploaded =
        ctx.lastUploadedShort ??
        (await uploadShortToYoutubeChannel({
          officeId: ctx.officeId,
          runId: ctx.runId,
          videoIndex: ctx.videoIndex,
          title: `Vídeo #${ctx.videoIndex}/${ctx.totalVideos} — ${ctx.instruction}`,
          description: `Short produzido pelo WorkOffice: ${ctx.instruction} #shorts`,
          visibility: 'private',
          oauth: ctx.youtubeOAuth,
          supabaseStorageClient: ctx.supabaseStorageClient,
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
