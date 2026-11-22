import { describe, expect, it } from 'vitest';
import {
  AgentEventRecordSchema,
  canAccessOfficeStoragePath,
  EFFORT_CONFIG_MAP,
  estimateTaskCostUsd,
  EVENT_VISUAL_CATALOG,
  getModelFromCatalog,
  planYoutubeShortPublication,
  PublishReportOutputSchema,
  ResearchBriefOutputSchema,
  ScriptwriterInputSchema,
  VideoEditorOutputSchema,
  YOUTUBE_DAILY_MAX_UPLOADS,
  YOUTUBE_SHORTS_ROLES,
} from '../index.js';

describe('@workoffice/shared — Etapa 2 (Catalogo LLM, Eventos, Cargos e RLS Storage)', () => {
  it('mapeia corretamente os 3 niveis de esforco (low, medium, high)', () => {
    expect(EFFORT_CONFIG_MAP.low.maxOutputTokens).toBe(2048);
    expect(EFFORT_CONFIG_MAP.low.thinkingBudgetTokens).toBe(0);
    expect(EFFORT_CONFIG_MAP.medium.thinkingBudgetTokens).toBe(4096);
    expect(EFFORT_CONFIG_MAP.high.maxToolIterations).toBe(25);
  });

  it('calcula estimativa de custo maior para esforco high do que low no mesmo modelo', () => {
    const model = getModelFromCatalog('gemini-2.5-pro');
    expect(model?.provider).toBe('google');

    const lowCost = estimateTaskCostUsd('gemini-2.5-pro', 'low');
    const highCost = estimateTaskCostUsd('gemini-2.5-pro', 'high');
    expect(lowCost).toBeGreaterThan(0);
    expect(highCost).toBeGreaterThan(lowCost);
  });

  it('valida eventos visuais e mapeia todos os 16 tipos para hotspots e icones', () => {
    expect(Object.keys(EVENT_VISUAL_CATALOG)).toHaveLength(16);
    expect(EVENT_VISUAL_CATALOG['research.read_source'].targetHotspot).toBe('own_shelf');
    expect(EVENT_VISUAL_CATALOG['budget.exceeded'].bubbleIcon).toBe('💤');

    const eventParse = AgentEventRecordSchema.safeParse({
      id: 42,
      office_id: '11111111-1111-1111-1111-111111111111',
      agent_id: '22222222-2222-2222-2222-222222222222',
      task_id: '33333333-3333-3333-3333-333333333333',
      type: 'edit.cut',
      payload: { progress: 65, message: 'Cortando Short vertical 9:16' },
      created_at: new Date().toISOString(),
    });
    expect(eventParse.success).toBe(true);
  });

  it('valida contratos de input/output dos 3 cargos do Estudio de Shorts', () => {
    expect(YOUTUBE_SHORTS_ROLES.map((r) => r.slug)).toEqual([
      'scriptwriter',
      'video_editor',
      'publisher_analyst',
    ]);

    const validScriptInput = ScriptwriterInputSchema.safeParse({
      podcast_name: 'Flow Tech',
      channel_url: 'https://www.youtube.com/@podcast',
      topic: 'Agentes de IA',
      clip_count: 2,
    });
    expect(validScriptInput.success).toBe(true);

    const validResearchBrief = ResearchBriefOutputSchema.safeParse({
      clips: [
        {
          source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          start_sec: 120,
          end_sec: 175,
          hook: 'Ninguem esperava essa resposta sobre agentes...',
          suggested_title: 'O futuro dos Agentes de IA em 55 segundos #shorts',
          rationale: 'Pico de retencao e mudanca de tom na conversa.',
          score: 94,
        },
      ],
    });
    expect(validResearchBrief.success).toBe(true);

    // Rejeita corte com mais de 60 segundos
    const invalidOver60s = ResearchBriefOutputSchema.safeParse({
      clips: [
        {
          source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          start_sec: 10,
          end_sec: 95,
          hook: 'Gancho longo',
          suggested_title: 'Corte invalido',
          rationale: 'Estoura 60s',
          score: 50,
        },
      ],
    });
    expect(invalidOver60s.success).toBe(false);

    expect(
      VideoEditorOutputSchema.safeParse({
        edited_shorts: [
          {
            storage_path: '11111111-1111-1111-1111-111111111111/run-1/short-1.mp4',
            subtitle_path: '11111111-1111-1111-1111-111111111111/run-1/short-1.srt',
            duration_sec: 55,
            resolution: '1080x1920',
            suggested_title: 'O futuro dos Agentes de IA #shorts',
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      PublishReportOutputSchema.safeParse({
        published_videos: [
          {
            youtube_video_id: 'yt_short_001',
            url: 'https://youtube.com/shorts/yt_short_001',
            title: 'O futuro dos Agentes de IA #shorts',
            visibility: 'private',
            scheduled_at: new Date().toISOString(),
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('impede leitura/escrita cruzada no Storage entre escritorios de contas diferentes', () => {
    const userAOffices = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'];
    const pathOfficeA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/run-1/short.mp4';
    const pathOfficeB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/run-9/short.mp4';

    expect(canAccessOfficeStoragePath(pathOfficeA, userAOffices)).toBe(true);
    expect(canAccessOfficeStoragePath(pathOfficeB, userAOffices)).toBe(false);
  });

  it('respeita a periodicidade maxima e cota diaria do Publicador (6 videos/dia): publica com URL ate o 6o e agenda automaticamente do 7o em diante', () => {
    expect(YOUTUBE_DAILY_MAX_UPLOADS).toBe(6);

    const video1 = planYoutubeShortPublication({
      videoIndex: 1,
      videoId: 'yt_short_01',
    });
    expect(video1.isWithinDailyQuota).toBe(true);
    expect(video1.publicationStatus).toBe('published');
    expect(video1.scheduleDetails).toBeNull();
    expect(video1.outputSummary).toContain('https://youtube.com/shorts/yt_short_01');

    const video6 = planYoutubeShortPublication({
      videoIndex: 6,
      videoId: 'yt_short_06',
    });
    expect(video6.isWithinDailyQuota).toBe(true);
    expect(video6.publicationStatus).toBe('published');
    expect(video6.dailyQuotaUsedVideos).toBe(6);

    // 7o video excede a cota diaria (9.600 / 10.000 unidades) -> deve agendar para Dia +1, Slot 1/6
    const video7 = planYoutubeShortPublication({
      videoIndex: 7,
      videoId: 'yt_short_07',
    });
    expect(video7.isWithinDailyQuota).toBe(false);
    expect(video7.publicationStatus).toBe('scheduled');
    expect(video7.dayOffset).toBe(1);
    expect(video7.slotInDay).toBe(1);
    expect(video7.scheduleDetails?.is_scheduled_due_to_quota).toBe(true);
    expect(video7.outputSummary).toContain('Agendamento Programado:');
  });
});
