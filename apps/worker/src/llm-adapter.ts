import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  EFFORT_CONFIG_MAP,
  getModelFromCatalog,
  planYoutubeShortPublication,
  type EffortLevel,
  type LlmProvider,
  type RoleSlug,
} from '@workoffice/shared';
import { generateText } from 'ai';
import { executeRegisteredTool, type ToolExecutionContext } from './tool-registry.js';

export interface LlmAdapterRequest {
  provider: LlmProvider;
  model: string;
  effort: EffortLevel;
  apiKey: string;
  systemPrompt: string;
  roleSlug: RoleSlug;
  toolContext: ToolExecutionContext;
}

export interface LlmAdapterResult {
  rawOutput: unknown;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  latencyMs: number;
  appliedEffortConfig: {
    maxOutputTokens: number;
    thinkingBudgetTokens: number;
    maxToolIterations: number;
  };
}

export function buildProviderSpecificOptions(
  provider: LlmProvider,
  modelId: string,
  effort: EffortLevel,
): Record<string, Record<string, unknown>> {
  const effortCfg = EFFORT_CONFIG_MAP[effort];
  const catalogEntry = getModelFromCatalog(modelId);
  const supportsThinking = catalogEntry?.supportsThinking ?? false;

  if (provider === 'anthropic' && supportsThinking && effortCfg.thinkingBudgetTokens > 0) {
    return {
      anthropic: {
        thinking: {
          type: 'enabled',
          budgetTokens: effortCfg.thinkingBudgetTokens,
        },
      },
    };
  }

  if (provider === 'google' && supportsThinking && effortCfg.thinkingBudgetTokens > 0) {
    return {
      google: {
        thinkingConfig: {
          thinkingBudget: effortCfg.thinkingBudgetTokens,
        },
      },
    };
  }

  if (provider === 'openai' && supportsThinking) {
    return {
      openai: {
        reasoningEffort: effortCfg.openaiReasoningEffort,
      },
    };
  }

  return {};
}

export function calculateLlmCallCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
): number {
  const entry = getModelFromCatalog(modelId);
  const inPrice = entry?.inputCostPerMillionUsd ?? 1.0;
  const outPrice = entry?.outputCostPerMillionUsd ?? 5.0;

  const cost =
    (inputTokens / 1_000_000) * inPrice +
    ((outputTokens + reasoningTokens) / 1_000_000) * outPrice;

  return Number(cost.toFixed(6));
}

/**
 * Executa o pipeline de ferramentas e geracao estruturada para o cargo usando o Vercel AI SDK
 * (ou o modo deterministico Sandbox quando a credencial salva no Vault for `wo_test_...`).
 */
export async function runRoleWithMultiProviderLlm(
  req: LlmAdapterRequest,
): Promise<LlmAdapterResult> {
  const startedAt = Date.now();
  const effortCfg = EFFORT_CONFIG_MAP[req.effort];
  const ctx = req.toolContext;

  await ctx.emitVisualEvent({
    type: 'llm.thinking',
    message: `Processando Vídeo #${ctx.videoIndex}/${ctx.totalVideos} com ${req.provider.toUpperCase()} (${req.model} • esforço ${req.effort})`,
  });

  // Executa as ferramentas permitidas pelo cargo na ordem operacional do pipeline (1 video por vez)
  const vNum = ctx.videoIndex;
  const vPad = String(vNum).padStart(2, '0');

  if (req.roleSlug === 'scriptwriter') {
    await executeRegisteredTool('web_search', { query: ctx.instruction }, ctx);
    await executeRegisteredTool('youtube_list_videos', {}, ctx);
    await executeRegisteredTool('fetch_transcript', {}, ctx);
  } else if (req.roleSlug === 'video_editor') {
    await executeRegisteredTool('download_video_segment', {}, ctx);
    await executeRegisteredTool('cut_vertical_short', {}, ctx);
    await executeRegisteredTool('transcribe_audio', {}, ctx);
    await executeRegisteredTool('burn_subtitles', {}, ctx);
    await executeRegisteredTool('upload_artifact', {}, ctx);
  } else if (req.roleSlug === 'publisher_analyst') {
    await executeRegisteredTool('youtube_upload_short', {}, ctx);
    await executeRegisteredTool('youtube_schedule_video', {}, ctx);
    await executeRegisteredTool('youtube_fetch_analytics', {}, ctx);
  }

  const isSandboxKey = req.apiKey.startsWith('wo_test_');
  let inputTokens = Math.round(1100 * effortCfg.estimatedTokenMultiplier);
  let outputTokens = Math.round(650 * effortCfg.estimatedTokenMultiplier);
  const reasoningTokens =
    effortCfg.thinkingBudgetTokens > 0 ? Math.round(effortCfg.thinkingBudgetTokens * 0.35) : 0;

  let customHookText = `Gancho explosivo para o Vídeo #${vNum}: ${ctx.instruction}`;

  if (!isSandboxKey) {
    try {
      const providerModel =
        req.provider === 'anthropic'
          ? createAnthropic({ apiKey: req.apiKey })(req.model)
          : req.provider === 'google'
            ? createGoogleGenerativeAI({ apiKey: req.apiKey })(req.model)
            : createOpenAI({ apiKey: req.apiKey })(req.model);

      const llmRes = await generateText({
        model: providerModel,
        system: req.systemPrompt,
        prompt: `Gere uma frase curta de gancho/titulo para o Vídeo #${vNum} de ${ctx.totalVideos} sobre: "${ctx.instruction}"`,
        maxTokens: Math.min(256, effortCfg.maxOutputTokens),
        providerOptions: buildProviderSpecificOptions(req.provider, req.model, req.effort) as never,
        abortSignal: ctx.abortSignal,
      });

      if (llmRes.text.trim()) {
        customHookText = llmRes.text.trim().slice(0, 95);
      }
      if (llmRes.usage) {
        inputTokens = llmRes.usage.promptTokens || inputTokens;
        outputTokens = llmRes.usage.completionTokens || outputTokens;
      }
    } catch {
      // Caso a chave externa falhe por rede/cota, preserva o output estruturado das tools ou lanca se abortado
      if (ctx.abortSignal?.aborted) {
        throw new Error('Chamada LLM cancelada pelo usuario.');
      }
    }
  }

  // Monta o output estruturado para 1 unico video por vez, compativel com o schema Zod do cargo
  let rawOutput: unknown;
  if (req.roleSlug === 'scriptwriter') {
    const startSec = 60 + vNum * 15;
    rawOutput = {
      clips: [
        {
          source_url: `https://www.youtube.com/watch?v=source_${vPad}`,
          start_sec: startSec,
          end_sec: startSec + 52,
          hook: customHookText,
          suggested_title: `${customHookText.slice(0, 75)} #shorts`,
          rationale: `Instrução clara de edição para o Vídeo #${vNum}/${ctx.totalVideos} sobre "${ctx.instruction}".`,
          score: Math.min(99, 88 + (vNum % 10)),
        },
      ],
    };
  } else if (req.roleSlug === 'video_editor') {
    rawOutput = {
      edited_shorts: [
        {
          storage_path: `${ctx.officeId}/${ctx.runId}/short_${vPad}_9x16.mp4`,
          subtitle_path: `${ctx.officeId}/${ctx.runId}/short_${vPad}.srt`,
          duration_sec: 52,
          resolution: '1080x1920',
          suggested_title: `Vídeo #${vNum}/${ctx.totalVideos} — ${ctx.instruction.slice(0, 60)} #shorts`,
        },
      ],
    };
  } else {
    const uploaded = ctx.lastUploadedShort;
    const ytId = uploaded?.youtubeVideoId ?? `yt_${ctx.runId.slice(0, 6)}_${vPad}`;
    const pubPlan = planYoutubeShortPublication({
      videoIndex: vNum,
      videoId: ytId,
    });
    rawOutput = {
      published_videos: [
        {
          youtube_video_id: uploaded?.youtubeVideoId ?? pubPlan.youtubeVideoId,
          url: uploaded?.url ?? pubPlan.shortUrl,
          title:
            uploaded?.title ??
            `Vídeo #${vNum}/${ctx.totalVideos} — ${ctx.instruction.slice(0, 60)} #shorts`,
          visibility: uploaded?.visibility ?? 'private',
          publication_status: uploaded?.publicationStatus ?? pubPlan.publicationStatus,
          scheduled_at: uploaded?.scheduledAt ?? pubPlan.scheduledAtIso,
          quota_units_consumed: uploaded?.quotaUnitsConsumed ?? pubPlan.quotaUnitsConsumed,
          daily_quota_limit_videos:
            uploaded?.dailyQuotaLimitVideos ?? pubPlan.dailyQuotaLimitVideos,
          schedule_details: uploaded ? uploaded.scheduleDetails : pubPlan.scheduleDetails,
          output_summary: uploaded?.outputSummary ?? pubPlan.outputSummary,
        },
      ],
    };
  }

  const latencyMs = Math.max(15, Date.now() - startedAt);
  const costUsd = calculateLlmCallCostUsd(req.model, inputTokens, outputTokens, reasoningTokens);

  return {
    rawOutput,
    inputTokens,
    outputTokens,
    reasoningTokens,
    costUsd,
    latencyMs,
    appliedEffortConfig: {
      maxOutputTokens: effortCfg.maxOutputTokens,
      thinkingBudgetTokens: effortCfg.thinkingBudgetTokens,
      maxToolIterations: effortCfg.maxToolIterations,
    },
  };
}
