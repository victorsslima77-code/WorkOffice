import { z } from 'zod';
import { EffortLevelSchema } from './models.js';

export const RoleSlugSchema = z.enum(['scriptwriter', 'video_editor', 'publisher_analyst']);
export type RoleSlug = z.infer<typeof RoleSlugSchema>;

export const DeskSlotSchema = z.enum(['desk_1', 'desk_2', 'desk_3']);
export type DeskSlot = z.infer<typeof DeskSlotSchema>;

/**
 * Parametros de Cota Diaria e Periodicidade Maxima do Publicador (YouTube Data API v3):
 * - Cota padrao: 10.000 unidades/dia
 * - Custo por upload de video: ~1.600 unidades -> teto seguro de 6 videos publicados/dia (9.600 unidades)
 * - Periodicidade maxima: 1 video a cada 4 horas (6 slots diarios de 4h em 24h)
 * - Se produzirem mais videos do que a cota diaria (> 6 videos/dia), o Publicador agenda
 *   automaticamente os videos excedentes para os slots dos proximos dias.
 */
export const YOUTUBE_DAILY_QUOTA_UNITS = 10_000;
export const YOUTUBE_UPLOAD_COST_UNITS = 1_600;
export const YOUTUBE_DAILY_MAX_UPLOADS = Math.floor(
  YOUTUBE_DAILY_QUOTA_UNITS / YOUTUBE_UPLOAD_COST_UNITS,
); // 6 videos/dia
export const YOUTUBE_PUBLISH_INTERVAL_HOURS = 4; // 24h / 6 videos = 4h entre publicacoes

// 1. Roteirista / Pesquisador (scriptwriter)
export const ScriptwriterInputSchema = z.object({
  podcast_name: z.string().trim().min(2),
  channel_url: z.string().trim().url(),
  topic: z.string().trim().min(2),
  clip_count: z.number().int().min(1).max(10).default(3),
});
export type ScriptwriterInput = z.infer<typeof ScriptwriterInputSchema>;

export const CandidateClipSchema = z
  .object({
    source_url: z.string().url(),
    start_sec: z.number().min(0),
    end_sec: z.number().min(5),
    hook: z.string().min(3),
    suggested_title: z.string().min(3).max(100),
    rationale: z.string().min(5),
    score: z.number().min(0).max(100),
  })
  .refine((clip) => clip.end_sec > clip.start_sec && clip.end_sec - clip.start_sec <= 60, {
    message: 'Cada corte de Short deve ter duracao positiva e no maximo 60 segundos.',
    path: ['end_sec'],
  });
export type CandidateClip = z.infer<typeof CandidateClipSchema>;

export const ResearchBriefOutputSchema = z.object({
  clips: z.array(CandidateClipSchema).min(1).max(10),
});
export type ResearchBriefOutput = z.infer<typeof ResearchBriefOutputSchema>;

// 2. Editor de Video (video_editor)
export const VideoEditorInputSchema = ResearchBriefOutputSchema;
export type VideoEditorInput = z.infer<typeof VideoEditorInputSchema>;

export const EditedShortItemSchema = z.object({
  storage_path: z.string().min(3),
  subtitle_path: z.string().min(3),
  duration_sec: z.number().positive().max(60),
  resolution: z.literal('1080x1920').or(z.string().min(3)),
  suggested_title: z.string().min(3).max(100),
});
export type EditedShortItem = z.infer<typeof EditedShortItemSchema>;

export const VideoEditorOutputSchema = z.object({
  edited_shorts: z.array(EditedShortItemSchema).min(1),
});
export type VideoEditorOutput = z.infer<typeof VideoEditorOutputSchema>;

// 3. Publicador / Analista (publisher_analyst)
export const PublisherAnalystInputSchema = z.object({
  edited_shorts: z.array(EditedShortItemSchema).min(1),
  publish_visibility: z.enum(['private', 'unlisted', 'public']).default('private'),
});
export type PublisherAnalystInput = z.infer<typeof PublisherAnalystInputSchema>;

export const PublicationScheduleDetailsSchema = z.object({
  is_scheduled_due_to_quota: z.boolean(),
  day_offset: z.number().int().nonnegative(),
  slot_in_day: z.number().int().min(1).max(YOUTUBE_DAILY_MAX_UPLOADS),
  daily_quota_limit_videos: z.number().int().positive(),
  interval_hours: z.number().positive(),
  scheduled_for_iso: z.string(),
  scheduled_for_formatted: z.string(),
  quota_units_reserved: z.number().int().nonnegative(),
  reason: z.string().min(3),
});
export type PublicationScheduleDetails = z.infer<typeof PublicationScheduleDetailsSchema>;

export const PublishedVideoItemSchema = z.object({
  youtube_video_id: z.string().min(3),
  url: z.string().url(),
  title: z.string().min(3),
  visibility: z.enum(['private', 'unlisted', 'public']),
  publication_status: z.enum(['published', 'scheduled']).default('published'),
  scheduled_at: z.string(),
  quota_units_consumed: z.number().int().nonnegative().default(YOUTUBE_UPLOAD_COST_UNITS),
  daily_quota_limit_videos: z.number().int().positive().default(YOUTUBE_DAILY_MAX_UPLOADS),
  schedule_details: PublicationScheduleDetailsSchema.nullable().optional(),
  output_summary: z.string().optional(),
});
export type PublishedVideoItem = z.infer<typeof PublishedVideoItemSchema>;

export const PublishReportOutputSchema = z.object({
  published_videos: z.array(PublishedVideoItemSchema).min(1),
});
export type PublishReportOutput = z.infer<typeof PublishReportOutputSchema>;

export interface YoutubePublicationPlan {
  videoIndex: number;
  youtubeVideoId: string;
  shortUrl: string;
  publicationStatus: 'published' | 'scheduled';
  isWithinDailyQuota: boolean;
  dailyQuotaUsedVideos: number;
  dailyQuotaLimitVideos: number;
  quotaUnitsConsumed: number;
  dailyQuotaUnitsLimit: number;
  dayOffset: number;
  slotInDay: number;
  intervalHours: number;
  scheduledAtIso: string;
  scheduledForFormatted: string;
  scheduleDetails: PublicationScheduleDetails | null;
  /**
   * Output principal do Publicador:
   * - Quando dentro da cota diaria (<= 6 videos/dia): a URL do Short publicado.
   * - Quando excede a cota diaria (> 6 videos/dia): o detalhe completo do agendamento.
   */
  outputSummary: string;
}

/**
 * Calcula o plano de publicacao ou agendamento de 1 Short respeitando a periodicidade maxima
 * (a cada 4h) e a cota diaria da YouTube Data API v3 (10.000 un./dia = max 6 videos/dia).
 */
export function planYoutubeShortPublication(params: {
  videoIndex: number;
  alreadyPublishedTodayCount?: number;
  dailyLimit?: number;
  intervalHours?: number;
  baseDate?: Date;
  videoId?: string;
}): YoutubePublicationPlan {
  const safeVideoIndex = Math.max(1, Math.round(params.videoIndex));
  const dailyLimit = Math.max(1, params.dailyLimit ?? YOUTUBE_DAILY_MAX_UPLOADS);
  const intervalHours = Math.max(1, params.intervalHours ?? YOUTUBE_PUBLISH_INTERVAL_HOURS);
  const alreadyPublished = Math.max(
    0,
    params.alreadyPublishedTodayCount ?? safeVideoIndex - 1,
  );
  const globalZeroBasedIndex = alreadyPublished;
  const dayOffset = Math.floor(globalZeroBasedIndex / dailyLimit);
  const slotInDay = (globalZeroBasedIndex % dailyLimit) + 1;
  const isWithinDailyQuota = dayOffset === 0;

  const baseMs = (params.baseDate ?? new Date()).getTime();
  // Dentro da cota do dia: publicado respeitando a janela do slot atual;
  // Acima da cota diaria (dayOffset >= 1): agendado para o Dia +dayOffset no slot correspondente (a cada 4h)
  const scheduledOffsetHours = isWithinDailyQuota
    ? (slotInDay - 1) * intervalHours
    : dayOffset * 24 + (slotInDay - 1) * intervalHours;
  const targetDate = new Date(baseMs + scheduledOffsetHours * 3_600_000);
  const scheduledAtIso = targetDate.toISOString();

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const formattedDate = `${pad2(targetDate.getUTCDate())}/${pad2(targetDate.getUTCMonth() + 1)}/${targetDate.getUTCFullYear()} às ${pad2(targetDate.getUTCHours())}:${pad2(targetDate.getUTCMinutes())} UTC`;

  const vPad = pad2(safeVideoIndex);
  const youtubeVideoId = params.videoId ?? `yt_short_${vPad}`;
  const shortUrl = `https://youtube.com/shorts/${youtubeVideoId}`;

  if (isWithinDailyQuota) {
    const usedUnits = slotInDay * YOUTUBE_UPLOAD_COST_UNITS;
    return {
      videoIndex: safeVideoIndex,
      youtubeVideoId,
      shortUrl,
      publicationStatus: 'published',
      isWithinDailyQuota: true,
      dailyQuotaUsedVideos: slotInDay,
      dailyQuotaLimitVideos: dailyLimit,
      quotaUnitsConsumed: YOUTUBE_UPLOAD_COST_UNITS,
      dailyQuotaUnitsLimit: YOUTUBE_DAILY_QUOTA_UNITS,
      dayOffset: 0,
      slotInDay,
      intervalHours,
      scheduledAtIso,
      scheduledForFormatted: formattedDate,
      scheduleDetails: null,
      outputSummary: `URL do Short Publicado: ${shortUrl} (Cota diária: ${slotInDay}/${dailyLimit} vídeos • ${usedUnits}/${YOUTUBE_DAILY_QUOTA_UNITS} un. • periodicidade ${intervalHours}h)`,
    };
  }

  const reason = `Cota diária da YouTube Data API v3 atingida (${dailyLimit}/${dailyLimit} vídeos • ${dailyLimit * YOUTUBE_UPLOAD_COST_UNITS}/${YOUTUBE_DAILY_QUOTA_UNITS} unidades/dia). Publicação agendada automaticamente mantendo a periodicidade máxima de 1 Short a cada ${intervalHours}h.`;

  const scheduleDetails: PublicationScheduleDetails = {
    is_scheduled_due_to_quota: true,
    day_offset: dayOffset,
    slot_in_day: slotInDay,
    daily_quota_limit_videos: dailyLimit,
    interval_hours: intervalHours,
    scheduled_for_iso: scheduledAtIso,
    scheduled_for_formatted: formattedDate,
    quota_units_reserved: YOUTUBE_UPLOAD_COST_UNITS,
    reason,
  };

  return {
    videoIndex: safeVideoIndex,
    youtubeVideoId,
    shortUrl,
    publicationStatus: 'scheduled',
    isWithinDailyQuota: false,
    dailyQuotaUsedVideos: dailyLimit,
    dailyQuotaLimitVideos: dailyLimit,
    quotaUnitsConsumed: YOUTUBE_UPLOAD_COST_UNITS,
    dailyQuotaUnitsLimit: YOUTUBE_DAILY_QUOTA_UNITS,
    dayOffset,
    slotInDay,
    intervalHours,
    scheduledAtIso,
    scheduledForFormatted: formattedDate,
    scheduleDetails,
    outputSummary: `Agendamento Programado: ${formattedDate} (Dia +${dayOffset} • Slot ${slotInDay}/${dailyLimit} • intervalo de ${intervalHours}h — excedeu cota diária de ${dailyLimit} vídeos/dia)`,
  };
}

export interface OfficeRoleDefinition {
  slug: RoleSlug;
  name: string;
  deskSlot: DeskSlot;
  defaultEffort: z.infer<typeof EffortLevelSchema>;
  allowedTools: readonly string[];
  workstationType: string;
  scope: string;
  systemPrompt: string;
  inputContractSummary: string;
  outputContractSummary: string;
}

export const ROLE_TOOL_DESCRIPTIONS: Record<
  string,
  { name: string; eventType: string; description: string }
> = {
  web_search: {
    name: 'web_search',
    eventType: 'research.web_search',
    description:
      'Pesquisa tópicos em alta, notícias e tendências de retenção relacionadas ao tema solicitado pelo usuário.',
  },
  youtube_list_videos: {
    name: 'youtube_list_videos',
    eventType: 'research.web_search',
    description:
      'Lista episódios e vídeos recentes do canal/podcast alvo com validação anti-SSRF.',
  },
  fetch_transcript: {
    name: 'fetch_transcript',
    eventType: 'research.read_source',
    description:
      'Extrai a transcrição com timestamps e seleciona a melhor janela contínua de até 60 segundos.',
  },
  read_source: {
    name: 'read_source',
    eventType: 'research.read_source',
    description:
      'Consulta referências complementares e pautas anteriores na estante da Baia 1.',
  },
  download_video_segment: {
    name: 'download_video_segment',
    eventType: 'edit.download',
    description:
      'Baixa exclusivamente o trecho selecionado (start_sec..end_sec) via yt-dlp com proteção anti-SSRF.',
  },
  transcribe_audio: {
    name: 'transcribe_audio',
    eventType: 'edit.subtitle',
    description:
      'Transcreve o áudio do corte e gera o arquivo de legendas dinâmicas (.srt) sincronizado.',
  },
  cut_vertical_short: {
    name: 'cut_vertical_short',
    eventType: 'edit.cut',
    description:
      'Recorta e reenquadra o vídeo para a proporção vertical 9:16 (1080x1920, <= 60s) via ffmpeg.',
  },
  burn_subtitles: {
    name: 'burn_subtitles',
    eventType: 'edit.render',
    description:
      'Renderiza o burn-in das legendas estilizadas de alta retenção sobre o vídeo vertical.',
  },
  upload_artifact: {
    name: 'upload_artifact',
    eventType: 'edit.render',
    description:
      'Faz upload do pacote final (.mp4 9:16 + .srt) para os buckets privados do Supabase Storage.',
  },
  youtube_upload_short: {
    name: 'youtube_upload_short',
    eventType: 'publish.upload',
    description:
      'Verifica a cota diária da YouTube Data API v3 (máx. 6 vídeos/dia) e publica o Short via OAuth 2.0.',
  },
  youtube_schedule_video: {
    name: 'youtube_schedule_video',
    eventType: 'publish.upload',
    description:
      'Mantém a periodicidade máxima (1 vídeo a cada 4h, máx. 6/dia) e agenda automaticamente vídeos excedentes.',
  },
  youtube_fetch_analytics: {
    name: 'youtube_fetch_analytics',
    eventType: 'metrics.check',
    description:
      'Coleta métricas de visualizações, likes, comentários e retenção na YouTube Analytics API.',
  },
};

export const YOUTUBE_SHORTS_ROLES: readonly OfficeRoleDefinition[] = [
  {
    slug: 'scriptwriter',
    name: 'Roteirista / Pesquisador',
    deskSlot: 'desk_1',
    defaultEffort: 'medium',
    allowedTools: ['web_search', 'youtube_list_videos', 'fetch_transcript', 'read_source'],
    workstationType: 'research_desk',
    scope:
      'Pesquisar conteúdos em alta sobre o tema pedido e gerar 1 instrução clara de edição por vez para cada vídeo solicitado, depositando na estante do Editor (shelf_2).',
    systemPrompt:
      'Você é o Roteirista e Pesquisador de Shorts do WorkOffice (Baia 1). Você só inicia atividades ao receber uma instrução do usuário (ex.: "Crie 10 vídeos do vídeo game novo"). Para cada vídeo solicitado (1 a N), produza 1 documento claro de instruções de edição contendo: URL de origem validada, timestamp inicial e final (máx. 60s), gancho de abertura de alta retenção nos 3 primeiros segundos, roteiro de legenda e título SEO com #shorts. Entregue cada instrução individualmente na estante do Editor (Baia 2) e retorne imediatamente à sua mesa para produzir o próximo vídeo em paralelo.',
    inputContractSummary: 'Instrução do usuário (tema + quantidade N de vídeos a produzir).',
    outputContractSummary:
      '1 documento JSON de instrução clara de edição por vez (source_url, start_sec, end_sec <= 60s, hook, suggested_title, rationale, score) entregue na estante da Baia 2.',
  },
  {
    slug: 'video_editor',
    name: 'Editor de Vídeo',
    deskSlot: 'desk_2',
    defaultEffort: 'medium',
    allowedTools: [
      'download_video_segment',
      'transcribe_audio',
      'cut_vertical_short',
      'burn_subtitles',
      'upload_artifact',
    ],
    workstationType: 'editing_desk',
    scope:
      'Retirar 1 instrução de edição por vez na sua estante (shelf_2), baixar o trecho, recortar em formato vertical 9:16 (1080x1920, <=60s), queimar legendas dinâmicas e entregar na estante do Publicador (shelf_3).',
    systemPrompt:
      'Você é o Editor de Vídeo de Shorts do WorkOffice (Baia 2). Permaneça descansando na copa até receber um input na sua estante (shelf_2). Ao detectar uma instrução de edição na sua estante, retire-a, baixe o segmento com yt-dlp, gere a legenda .srt sincronizada, recorte em 9:16 vertical (1080x1920, duração <= 60s) com burn-in via ffmpeg e salve no Supabase Storage. Entregue 1 vídeo Short editado por vez na estante do Publicador (Baia 3) e continue até concluir todos os inputs da sua estante.',
    inputContractSummary:
      '1 instrução clara de edição (research_brief) retirada da sua própria estante (shelf_2).',
    outputContractSummary:
      '1 vídeo Short vertical MP4 (1080x1920, <=60s) + legenda .srt salvos no Storage e depositados na estante da Baia 3.',
  },
  {
    slug: 'publisher_analyst',
    name: 'Publicador / Analista',
    deskSlot: 'desk_3',
    defaultEffort: 'low',
    allowedTools: ['youtube_upload_short', 'youtube_schedule_video', 'youtube_fetch_analytics'],
    workstationType: 'publishing_desk',
    scope:
      'Retirar 1 vídeo editado por vez na sua estante (shelf_3), manter a periodicidade máxima respeitando a cota diária do YouTube (máx. 6 vídeos/dia, janela de 4h), publicar ou agendar excedentes e emitir a URL do Short ou o detalhe do agendamento.',
    systemPrompt:
      'Você é o Publicador e Analista de Shorts do WorkOffice (Baia 3). Permaneça descansando na copa até receber um vídeo editado na sua estante (shelf_3). Ao retirar o vídeo da estante, verifique a cota diária da YouTube Data API v3 (10.000 unidades/dia ÷ 1.600 unidades/upload = máximo de 6 vídeos publicados por dia, espaçados a cada 4 horas). Para vídeos dentro da cota diária (1 a 6), publique o Short e retorne a URL do Short publicado. Se produzirem mais vídeos do que a cota diária (7 em diante), agende automaticamente a publicação para as próximas janelas diárias e retorne o detalhe completo do agendamento (schedule_details).',
    inputContractSummary:
      '1 vídeo Short vertical editado e legendado (edited_short) retirado da sua estante (shelf_3).',
    outputContractSummary:
      '1 relatório (publish_report) contendo a URL do Short publicado (se <= 6/dia) OU o detalhe completo do agendamento (se > 6/dia) + métricas em video_metrics.',
  },
] as const;

/**
 * Valida se um caminho no Supabase Storage (<office_id>/<run_id>/<filename>)
 * pertence a um dos escritorios do usuario autenticado (espelhando a RLS de storage.objects).
 */
export function canAccessOfficeStoragePath(
  storagePath: string,
  ownedOfficeIds: readonly string[],
): boolean {
  const firstSegment = storagePath.split('/').filter(Boolean)[0];
  if (!firstSegment) {
    return false;
  }
  return ownedOfficeIds.includes(firstSegment);
}
