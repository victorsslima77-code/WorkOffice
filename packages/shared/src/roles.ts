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
); // 6 uploads tecnicos de API/dia
export const YOUTUBE_PUBLISH_INTERVAL_HOURS = 4; // 24h / 6 videos = 4h entre uploads tecnicos

/**
 * Parametros do Plano de Constancia de Posts do Publicador (Recomendacao de Especialistas):
 * - Limite diario de postagem ativa: 1 Short por dia (mesmo que receba 6 videos no dia, posta 1 hoje e agenda os outros 5 para os proximos dias)
 * - Semanas 1 a 3 (Fase de Aquecimento / Ramp-Up): 4 a 5 Shorts por semana (teto padrao: 5/semana, com 2 dias de respiro na semana)
 * - A partir da Semana 4 (Fase de Constancia Diaria): 7 Shorts por semana (1 por dia, todos os dias)
 */
export const YOUTUBE_DAILY_CONSISTENCY_MAX_POSTS = 1;
export const YOUTUBE_WARMUP_WEEKS_THRESHOLD = 3;
export const YOUTUBE_WARMUP_WEEKLY_POSTS_MIN = 4;
export const YOUTUBE_WARMUP_WEEKLY_POSTS_TARGET = 5;
export const YOUTUBE_MATURE_WEEKLY_POSTS_TARGET = 7;
export const YOUTUBE_PREFERRED_PUBLISH_HOUR_UTC = 21; // 18:00 BRT (Horario nobre de Shorts)

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
    seo_description: z.string().min(5).max(5000).optional(),
    seo_tags: z.array(z.string().min(1).max(60)).max(20).optional(),
    subtitle_instructions: z.string().min(3).optional(),
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
  thumbnail_path: z.string().min(3).optional(),
  duration_sec: z.number().positive().max(60),
  resolution: z.literal('1080x1920').or(z.string().min(3)),
  suggested_title: z.string().min(3).max(100),
  seo_description: z.string().max(5000).optional(),
  seo_tags: z.array(z.string().min(1).max(60)).max(20).optional(),
});
export type EditedShortItem = z.infer<typeof EditedShortItemSchema>;

export const VideoEditorOutputSchema = z.object({
  edited_shorts: z.array(EditedShortItemSchema).min(1),
});
export type VideoEditorOutput = z.infer<typeof VideoEditorOutputSchema>;

// 3. Publicador / Analista (publisher_analyst)
export const PublisherAnalystInputSchema = z.object({
  edited_shorts: z.array(EditedShortItemSchema).min(1),
  publish_visibility: z.enum(['private', 'unlisted', 'public']).default('public'),
});
export type PublisherAnalystInput = z.infer<typeof PublisherAnalystInputSchema>;

export const PublicationScheduleDetailsSchema = z.object({
  is_scheduled_due_to_quota: z.boolean(),
  is_scheduled_due_to_consistency: z.boolean().optional(),
  day_offset: z.number().int().nonnegative(),
  slot_in_day: z.number().int().min(1).max(YOUTUBE_DAILY_MAX_UPLOADS),
  daily_quota_limit_videos: z.number().int().positive(),
  daily_posts_limit: z.number().int().positive().optional(),
  channel_week_number: z.number().int().positive().optional(),
  weekly_phase: z.enum(['warmup_4_to_5_per_week', 'mature_7_per_week']).optional(),
  weekly_posts_target: z.number().int().positive().optional(),
  weekly_posts_allocated: z.number().int().positive().optional(),
  interval_hours: z.number().positive(),
  scheduled_for_iso: z.string(),
  scheduled_for_formatted: z.string(),
  quota_units_reserved: z.number().int().nonnegative(),
  reason: z.string().min(3),
  consistency_analysis: z.string().optional(),
});
export type PublicationScheduleDetails = z.infer<typeof PublicationScheduleDetailsSchema>;

export const PublishedVideoItemSchema = z.object({
  youtube_video_id: z.string().min(3),
  url: z.string().url(),
  title: z.string().min(3),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  thumbnail_path: z.string().optional(),
  thumbnail_applied: z.boolean().optional(),
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

export interface YoutubeConsistencySchedulePlan extends YoutubePublicationPlan {
  channelWeekNumber: number;
  weeklyPhase: 'warmup_4_to_5_per_week' | 'mature_7_per_week';
  weeklyPostsTarget: number;
  weeklyPostsAllocated: number;
  dailyPostsLimit: number;
  canUploadToYoutubeTodayWithPublishAt: boolean;
}

/**
 * Planejador Estrategico de Constancia de Posts do Agente Publicador:
 * - Limite estrito de 1 Short publicado por dia (mesmo que receba 6 videos no mesmo dia, posta apenas 1 hoje e agenda os 5 restantes para os proximos dias).
 * - Nas primeiras 3 semanas do escritorio/canal (Semanas 1 a 3): agenda de 4 a 5 Shorts por semana (teto de 5/semana com 2 dias de respiro para maturar o algoritmo).
 * - A partir da 4a semana (Semana 4+): sobe automaticamente para 7 Shorts por semana (1 por dia todos os dias).
 * - Leva em conta todos os Shorts ja publicados ou agendados anteriormente pelo escritorio (`existingScheduledDatesIso`).
 */
export function planYoutubeConsistencySchedule(params: {
  videoIndex: number;
  baseDate?: Date;
  officeCreatedAtIso?: string;
  existingScheduledDatesIso?: readonly string[];
  alreadyUploadedApiTodayCount?: number;
  preferredPublishHourUtc?: number;
  videoId?: string;
}): YoutubeConsistencySchedulePlan {
  const safeVideoIndex = Math.max(1, Math.round(params.videoIndex));
  const now = params.baseDate ?? new Date();
  const preferredHourUtc = params.preferredPublishHourUtc ?? YOUTUBE_PREFERRED_PUBLISH_HOUR_UTC;

  const toUtcDayStartMs = (d: Date): number =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const toDayKey = (dayStartMs: number): string => new Date(dayStartMs).toISOString().slice(0, 10);

  const todayStartMs = toUtcDayStartMs(now);

  // Determina a data de inicio do canal/escritorio para calcular em qual semana (1, 2, 3 ou 4+) estamos
  let channelEpochStartMs = todayStartMs;
  if (params.officeCreatedAtIso) {
    const parsedOfficeDate = new Date(params.officeCreatedAtIso);
    if (!Number.isNaN(parsedOfficeDate.getTime())) {
      channelEpochStartMs = Math.min(channelEpochStartMs, toUtcDayStartMs(parsedOfficeDate));
    }
  }

  const existingDates = (params.existingScheduledDatesIso ?? [])
    .map((iso) => new Date(iso))
    .filter((d) => !Number.isNaN(d.getTime()));

  for (const d of existingDates) {
    channelEpochStartMs = Math.min(channelEpochStartMs, toUtcDayStartMs(d));
  }

  const getWeekIndexFromEpoch = (dayStartMs: number): number =>
    Math.max(0, Math.floor((dayStartMs - channelEpochStartMs) / (7 * 86_400_000)));

  const occupiedDays = new Set<string>();
  const postsPerWeek = new Map<number, number>();

  for (const d of existingDates) {
    const dayMs = toUtcDayStartMs(d);
    const key = toDayKey(dayMs);
    if (!occupiedDays.has(key)) {
      occupiedDays.add(key);
      const wIdx = getWeekIndexFromEpoch(dayMs);
      postsPerWeek.set(wIdx, (postsPerWeek.get(wIdx) ?? 0) + 1);
    }
  }

  // Se existingScheduledDatesIso nao foi passado (ex.: simulacao pura de lote 1..N),
  // precisamos alocar os videos 1..(safeVideoIndex-1) antes de alocar o safeVideoIndex.
  // Se existingScheduledDatesIso JA veio do banco (que ja inclui os videos anteriores do lote),
  // alocamos apenas 1 novo slot livre!
  const stepsToAllocate =
    params.existingScheduledDatesIso !== undefined ? 1 : safeVideoIndex;

  let chosenDayStartMs = todayStartMs;
  let chosenDayOffset = 0;
  let chosenWeekNumber = 1;
  let chosenWeeklyTarget = YOUTUBE_WARMUP_WEEKLY_POSTS_TARGET;
  let chosenWeeklyAllocated = 1;

  for (let step = 1; step <= stepsToAllocate; step++) {
    for (let offset = 0; offset < 365; offset++) {
      const candidateDayMs = todayStartMs + offset * 86_400_000;
      const dayKey = toDayKey(candidateDayMs);
      if (occupiedDays.has(dayKey)) {
        continue; // Limite estrito: maximo 1 Short por dia!
      }

      const weekIdx = getWeekIndexFromEpoch(candidateDayMs);
      const weekNumber = weekIdx + 1;
      const isWarmupPhase = weekNumber <= YOUTUBE_WARMUP_WEEKS_THRESHOLD;
      const weeklyTarget = isWarmupPhase
        ? YOUTUBE_WARMUP_WEEKLY_POSTS_TARGET // 5 Shorts/semana nas primeiras 3 semanas (recomendacao 4-5/sem)
        : YOUTUBE_MATURE_WEEKLY_POSTS_TARGET; // 7 Shorts/semana a partir da 4a semana

      const usedInWeek = postsPerWeek.get(weekIdx) ?? 0;
      if (usedInWeek >= weeklyTarget) {
        continue; // Meta semanal atingida: aguarda os dias de respiro ate abrir a proxima semana!
      }

      occupiedDays.add(dayKey);
      const nextAllocated = usedInWeek + 1;
      postsPerWeek.set(weekIdx, nextAllocated);

      chosenDayStartMs = candidateDayMs;
      chosenDayOffset = offset;
      chosenWeekNumber = weekNumber;
      chosenWeeklyTarget = weeklyTarget;
      chosenWeeklyAllocated = nextAllocated;
      break;
    }
  }

  const weeklyPhase: 'warmup_4_to_5_per_week' | 'mature_7_per_week' =
    chosenWeekNumber <= YOUTUBE_WARMUP_WEEKS_THRESHOLD
      ? 'warmup_4_to_5_per_week'
      : 'mature_7_per_week';

  // Data/hora exata: se for hoje (chosenDayOffset === 0), publica agora;
  // se for nos proximos dias (chosenDayOffset >= 1), programa para o horario nobre (21:00 UTC = 18:00 BRT)
  const targetDate =
    chosenDayOffset === 0
      ? now
      : new Date(chosenDayStartMs + preferredHourUtc * 3_600_000);
  const scheduledAtIso = targetDate.toISOString();

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const formattedDate = `${pad2(targetDate.getUTCDate())}/${pad2(targetDate.getUTCMonth() + 1)}/${targetDate.getUTCFullYear()} às ${pad2(targetDate.getUTCHours())}:${pad2(targetDate.getUTCMinutes())} UTC`;

  const vPad = pad2(safeVideoIndex);
  const youtubeVideoId = params.videoId ?? `yt_short_${vPad}`;
  const shortUrl = `https://youtube.com/shorts/${youtubeVideoId}`;

  const apiUploadsBeforeThis =
    params.alreadyUploadedApiTodayCount ?? safeVideoIndex - 1;
  const isWithinDailyApiQuota = apiUploadsBeforeThis < YOUTUBE_DAILY_MAX_UPLOADS;
  const apiSlotToday = Math.min(YOUTUBE_DAILY_MAX_UPLOADS, apiUploadsBeforeThis + 1);

  const phaseLabel =
    weeklyPhase === 'warmup_4_to_5_per_week'
      ? `Semana ${chosenWeekNumber} (Aquecimento: 4–5 Shorts/semana • slot ${chosenWeeklyAllocated}/${chosenWeeklyTarget})`
      : `Semana ${chosenWeekNumber} (Escala Diária: 7 Shorts/semana • slot ${chosenWeeklyAllocated}/${chosenWeeklyTarget})`;

  // Caso 1: 1o Short do dia atual e dentro da meta semanal -> Publica HOJE imediatamente como PUBLICO!
  if (chosenDayOffset === 0 && isWithinDailyApiQuota) {
    return {
      videoIndex: safeVideoIndex,
      youtubeVideoId,
      shortUrl,
      publicationStatus: 'published',
      isWithinDailyQuota: true,
      dailyQuotaUsedVideos: apiSlotToday,
      dailyQuotaLimitVideos: YOUTUBE_DAILY_MAX_UPLOADS,
      quotaUnitsConsumed: YOUTUBE_UPLOAD_COST_UNITS,
      dailyQuotaUnitsLimit: YOUTUBE_DAILY_QUOTA_UNITS,
      dayOffset: 0,
      slotInDay: 1,
      intervalHours: 24,
      scheduledAtIso,
      scheduledForFormatted: formattedDate,
      scheduleDetails: null,
      channelWeekNumber: chosenWeekNumber,
      weeklyPhase,
      weeklyPostsTarget: chosenWeeklyTarget,
      weeklyPostsAllocated: chosenWeeklyAllocated,
      dailyPostsLimit: YOUTUBE_DAILY_CONSISTENCY_MAX_POSTS,
      canUploadToYoutubeTodayWithPublishAt: true,
      outputSummary: `URL do Short Publicado Hoje (1/1 do dia • ${phaseLabel}): ${shortUrl}`,
    };
  }

  // Caso 2: Ja houve 1 Short postado hoje (ou meta semanal de 5/semana atingida) -> Agenda para os proximos dias!
  const reason = isWithinDailyApiQuota
    ? `Plano de Constância de Posts (máx. 1 Short/dia • ${phaseLabel}): 1 Short já foi alocado para os dias anteriores, por isso este vídeo foi programado automaticamente para ${formattedDate} (Dia +${chosenDayOffset}).`
    : `Plano de Constância (máx. 1 Short/dia • ${phaseLabel}) + Cota Diária da API atingida (${YOUTUBE_DAILY_MAX_UPLOADS}/dia): programado para ${formattedDate} (Dia +${chosenDayOffset}).`;

  const scheduleDetails: PublicationScheduleDetails = {
    is_scheduled_due_to_quota: !isWithinDailyApiQuota,
    is_scheduled_due_to_consistency: true,
    day_offset: chosenDayOffset,
    slot_in_day: 1,
    daily_quota_limit_videos: YOUTUBE_DAILY_MAX_UPLOADS,
    daily_posts_limit: YOUTUBE_DAILY_CONSISTENCY_MAX_POSTS,
    channel_week_number: chosenWeekNumber,
    weekly_phase: weeklyPhase,
    weekly_posts_target: chosenWeeklyTarget,
    weekly_posts_allocated: chosenWeeklyAllocated,
    interval_hours: 24,
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
    isWithinDailyQuota: isWithinDailyApiQuota,
    dailyQuotaUsedVideos: apiSlotToday,
    dailyQuotaLimitVideos: YOUTUBE_DAILY_MAX_UPLOADS,
    quotaUnitsConsumed: YOUTUBE_UPLOAD_COST_UNITS,
    dailyQuotaUnitsLimit: YOUTUBE_DAILY_QUOTA_UNITS,
    dayOffset: chosenDayOffset,
    slotInDay: 1,
    intervalHours: 24,
    scheduledAtIso,
    scheduledForFormatted: formattedDate,
    scheduleDetails,
    channelWeekNumber: chosenWeekNumber,
    weeklyPhase,
    weeklyPostsTarget: chosenWeeklyTarget,
    weeklyPostsAllocated: chosenWeeklyAllocated,
    dailyPostsLimit: YOUTUBE_DAILY_CONSISTENCY_MAX_POSTS,
    canUploadToYoutubeTodayWithPublishAt: isWithinDailyApiQuota,
    outputSummary: `Agendamento de Constância Programado: ${formattedDate} (Dia +${chosenDayOffset} • máx. 1 Short/dia • ${phaseLabel}) — ${shortUrl}`,
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
      'Transcreve a fala real do áudio/vídeo no idioma original (sem traduzir e sem inserir instruções de edição) e gera legendas (.srt) sincronizadas.',
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
      'Procurar os vídeos mais em alta sobre o assunto pedido, analisar os pontos de pico de audiência ("Most Replayed") para centralizar o corte (<=60s) em volta do pico, definir título SEO, descrição SEO e tags SEO, depositando na estante do Editor (shelf_2).',
    systemPrompt:
      'Você é o Roteirista e Pesquisador de Shorts do WorkOffice (Baia 1). Você só inicia atividades ao receber uma instrução do usuário. Para cada vídeo solicitado (1 a N): (1) procure os vídeos mais em alta e com maior engajamento/visualizações sobre o assunto solicitado; (2) analise os pontos de pico de audiência ("Most Replayed" / retenção do YouTube) do vídeo observado e posicione o corte (start_sec e end_sec, duração de 25s a 58s) EM VOLTA do pico de audiência (por exemplo, se o pico ocorreu em 1:30, inicie ~10–15s antes para contexto e estenda ~30s após o pico); (3) defina título SEO viral com #shorts, as melhores tags de SEO (seo_tags) e uma descrição SEO completa (seo_description). Não gere instruções manuais de edição ou texto de legenda — o Editor cuida do corte e das legendas sobre a fala real. Entregue cada documento individualmente na estante do Editor (Baia 2).',
    inputContractSummary: 'Instrução do usuário (tema + quantidade N de vídeos a produzir).',
    outputContractSummary:
      '1 documento JSON de corte por vez (source_url em alta, start_sec, end_sec <= 60s, suggested_title, seo_description, seo_tags, hook, rationale, score) entregue na estante da Baia 2.',
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
      'Retirar 1 pauta de corte na sua estante (shelf_2), baixar o trecho [start_sec..end_sec], remover pausas silenciosas com transições sutis, aplicar punch-in zoom pontual e identidade visual própria, legendar EXCLUSIVAMENTE a fala real no idioma original com transições variadas (.ass), capturar thumbnail (.jpg) e entregar na estante do Publicador (shelf_3).',
    systemPrompt:
      'Você é o Editor de Vídeo de Shorts do WorkOffice (Baia 2) com identidade editorial própria e sutil (para enriquecer a edição e evitar flag de conteúdo repetitivo). Seu trabalho é: (1) baixar o trecho [start_sec..end_sec]; (2) cortar automaticamente pausas sem som mantendo ritmo natural; (3) aplicar transições sutis entre cortes (fade/dissolve/smooth) e punch-in zoom discreto em momentos-chave; (4) legendar EXCLUSIVAMENTE a fala real transcrita do áudio no idioma original (PT→PT, EN→EN — NUNCA traduza nem invente falas) com transições variadas e sutis (pop, fade_slide, blur_in); (5) capturar um frame de alta qualidade do vídeo como thumbnail (.jpg) e salvar MP4, SRT e thumbnail no Supabase Storage para o Publicador (Baia 3).',
    inputContractSummary:
      '1 corte selecionado (source_url, start_sec, end_sec) retirado da sua própria estante (shelf_2).',
    outputContractSummary:
      '1 vídeo Short vertical MP4 (1080x1920, <=60s) + legenda .srt da fala real + captura de thumbnail .jpg salvos no Storage e depositados na estante da Baia 3.',
  },
  {
    slug: 'publisher_analyst',
    name: 'Publicador / Analista',
    deskSlot: 'desk_3',
    defaultEffort: 'low',
    allowedTools: ['youtube_upload_short', 'youtube_schedule_video', 'youtube_fetch_analytics'],
    workstationType: 'publishing_desk',
    scope:
      'Retirar 1 vídeo editado por vez na sua estante (shelf_3), controlar toda a agenda de constância de posts do canal (limite estrito de 1 Short/dia; 4 a 5 Shorts/semana nas primeiras 3 semanas e 7 Shorts/semana a partir da 4ª semana), publicando apenas 1 vídeo no dia e programando os demais para os próximos dias com SEO completo e thumbnail.',
    systemPrompt:
      'Você é o Publicador e Analista Estrategista de Constância de Shorts do WorkOffice (Baia 3). Permaneça descansando na copa até receber um vídeo editado na sua estante (shelf_3). Ao retirar o vídeo da estante, controle rigorosamente o Plano de Constância de Posts do canal: (1) limite máximo de 1 Short publicado por dia — mesmo que receba 6 vídeos no mesmo dia (e que a cota técnica da API suporte 6 uploads/dia), publique apenas 1 Short hoje e programe os outros 5 para os próximos dias; (2) nas primeiras 3 semanas do canal/escritório (Semanas 1 a 3), mantenha a cadência recomendada por especialistas de 4 a 5 Shorts por semana (teto de 5/semana com dias de respiro); (3) a partir da 4ª semana (Semana 4+), escale a agenda para 7 Shorts por semana (1 por dia todos os dias); (4) aplique título SEO, descrição SEO envolvente, 10 a 15 tags SEO, thumbnail capturada pelo Editor e registre sua análise de constância (consistency_analysis) no relatório.',
    inputContractSummary:
      '1 vídeo Short vertical editado, legendado e com thumbnail capturada (edited_short) retirado da sua estante (shelf_3).',
    outputContractSummary:
      '1 relatório (publish_report) contendo a URL do Short publicado hoje (se 1º do dia) OU o agendamento programado na agenda de constância (1/dia • 4-5/sem nas semanas 1-3 • 7/sem na semana 4+) + métricas em video_metrics.',
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
