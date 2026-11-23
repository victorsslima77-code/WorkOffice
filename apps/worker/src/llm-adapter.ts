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

interface ParsedScriptwriterLlmJson {
  source_url?: string;
  start_sec?: number;
  end_sec?: number;
  suggested_title?: string;
  hook?: string;
  rationale?: string;
  score?: number;
}

function tryParseJsonFromLlmText(text: string): ParsedScriptwriterLlmJson | null {
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const startIdx = cleaned.indexOf('{');
  const endIdx = cleaned.lastIndexOf('}');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  try {
    return JSON.parse(cleaned.slice(startIdx, endIdx + 1)) as ParsedScriptwriterLlmJson;
  } catch {
    return null;
  }
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

  let parsedScriptJson: ParsedScriptwriterLlmJson | null = null;
  let generatedTitleFallback: string | null = null;

  if (!isSandboxKey) {
    try {
      const providerModel =
        req.provider === 'anthropic'
          ? createAnthropic({ apiKey: req.apiKey })(req.model)
          : req.provider === 'google'
            ? createGoogleGenerativeAI({ apiKey: req.apiKey })(req.model)
            : createOpenAI({ apiKey: req.apiKey })(req.model);

      // Garante que maxTokens seja sempre MAIOR que thinkingBudgetTokens (exigido por Gemini 2.5 e Claude Thinking!)
      const effectiveMaxTokens = Math.max(
        effortCfg.maxOutputTokens,
        effortCfg.thinkingBudgetTokens + 2048,
      );

      let rolePrompt: string;
      if (req.roleSlug === 'scriptwriter') {
        const candidatesList = (ctx.candidateVideos ?? [])
          .slice(0, 5)
          .map(
            (v, i) =>
              `${i + 1}. URL: ${v.url} | Título Original: "${v.title}" | Canal: ${v.channelTitle} | Duração: ${v.durationSec}s${v.description ? ` | Resumo: ${v.description.slice(0, 140)}` : ''}`,
          )
          .join('\n');

        rolePrompt = [
          `Pedido do usuário: "${ctx.instruction}" (produzindo Vídeo #${vNum} de ${ctx.totalVideos}).`,
          candidatesList
            ? `Vídeos REAIS encontrados no YouTube:\n${candidatesList}`
            : `URL de origem candidata: ${ctx.sourceUrl ?? 'não encontrada'}`,
          ctx.transcriptText
            ? `Contexto/descrição extraída do vídeo selecionado:\n${ctx.transcriptText.slice(0, 600)}`
            : '',
          `Retorne APENAS um JSON válido (sem markdown, sem comentários) com as chaves exatas:`,
          `{`,
          `  "source_url": "<escolha uma URL REAL da lista acima>",`,
          `  "start_sec": <numero inteiro em segundos, dentro da duracao do video>,`,
          `  "end_sec": <numero inteiro em segundos, sendo end_sec - start_sec entre 25 e 58 segundos>,`,
          `  "suggested_title": "<título viral, chamativo e natural em português para YouTube Shorts com até 85 caracteres terminando com #shorts — NUNCA repita o comando do usuário>",`,
          `  "hook": "<frase curta de impacto para os 3 primeiros segundos do Short que prende a atenção>",`,
          `  "rationale": "<instruções claras e detalhadas para o Editor: por que esse trecho retém audiência, ritmo de cortes, zoom e quais palavras destacar na legenda>",`,
          `  "score": <nota de retenção de 75 a 99>`,
          `}`,
        ]
          .filter(Boolean)
          .join('\n\n');
      } else {
        rolePrompt = `Crie um título viral curto (máx 80 caracteres, terminando com #shorts) em português para o Vídeo #${vNum}/${ctx.totalVideos} baseado no tema "${ctx.suggestedTitle ?? ctx.instruction}". Retorne apenas o título.`;
      }

      const llmRes = await generateText({
        model: providerModel,
        system: req.systemPrompt,
        prompt: rolePrompt,
        maxTokens: effectiveMaxTokens,
        providerOptions: buildProviderSpecificOptions(req.provider, req.model, req.effort) as never,
        abortSignal: ctx.abortSignal,
      });

      const rawText = llmRes.text.trim();
      if (rawText) {
        if (req.roleSlug === 'scriptwriter') {
          parsedScriptJson = tryParseJsonFromLlmText(rawText);
        } else {
          generatedTitleFallback = rawText.replace(/^["']|["']$/g, '').slice(0, 95);
        }
      }

      if (llmRes.usage) {
        inputTokens = llmRes.usage.promptTokens || inputTokens;
        outputTokens = llmRes.usage.completionTokens || outputTokens;
      }
    } catch (err) {
      console.error(
        `[WorkOffice LLM] Falha ao chamar ${req.provider}/${req.model}:`,
        (err as Error).message,
      );
      if (ctx.abortSignal?.aborted) {
        throw new Error('Chamada LLM cancelada pelo usuario.');
      }
    }
  }

  // Monta o output estruturado para 1 unico video por vez, compativel com o schema Zod do cargo
  let rawOutput: unknown;
  if (req.roleSlug === 'scriptwriter') {
    const validCandidateUrls = new Set((ctx.candidateVideos ?? []).map((v) => v.url));
    const llmChosenUrl =
      parsedScriptJson?.source_url &&
      (validCandidateUrls.size === 0 || validCandidateUrls.has(parsedScriptJson.source_url))
        ? parsedScriptJson.source_url
        : undefined;

    const finalSourceUrl =
      llmChosenUrl ?? ctx.sourceUrl ?? `https://www.youtube.com/watch?v=source_${vPad}`;

    const rawStart =
      typeof parsedScriptJson?.start_sec === 'number' && parsedScriptJson.start_sec >= 0
        ? Math.round(parsedScriptJson.start_sec)
        : (ctx.startSec ?? 30 + (vNum - 1) * 20);

    const rawEnd =
      typeof parsedScriptJson?.end_sec === 'number' &&
      parsedScriptJson.end_sec > rawStart &&
      parsedScriptJson.end_sec - rawStart <= 60
        ? Math.round(parsedScriptJson.end_sec)
        : Math.min(rawStart + 45, (ctx.sourceDurationSec ?? 600));

    const finalEndSec =
      rawEnd > rawStart && rawEnd - rawStart <= 60 ? rawEnd : rawStart + 45;

    const defaultRealTitle = ctx.sourceVideoTitle
      ? `${ctx.sourceVideoTitle.slice(0, 78)} #shorts`
      : (ctx.suggestedTitle ?? `Corte Viral #${vNum} #shorts`);

    const finalTitleRaw = parsedScriptJson?.suggested_title?.trim() || defaultRealTitle;
    const finalTitle = finalTitleRaw.toLowerCase().includes('#shorts')
      ? finalTitleRaw.slice(0, 98)
      : `${finalTitleRaw.slice(0, 88)} #shorts`;

    const finalHook =
      parsedScriptJson?.hook?.trim() ||
      ctx.hookText ||
      (ctx.sourceVideoTitle
        ? `Você viu esse momento de "${ctx.sourceVideoTitle.slice(0, 65)}"?`
        : `O momento mais insano desse vídeo!`);

    const finalRationale =
      parsedScriptJson?.rationale?.trim() ||
      `Corte vertical 9:16 extraído de "${ctx.sourceVideoTitle ?? finalSourceUrl}" (${ctx.sourceChannelName ?? 'YouTube'}) entre ${rawStart}s e ${finalEndSec}s. Destacar o gancho inicial nos 3 primeiros segundos, aplicar cortes dinâmicos e queimar legendas amarelas sincronizadas.`;

    const finalScore =
      typeof parsedScriptJson?.score === 'number' &&
      parsedScriptJson.score >= 0 &&
      parsedScriptJson.score <= 100
        ? Math.round(parsedScriptJson.score)
        : Math.min(99, 89 + (vNum % 10));

    rawOutput = {
      clips: [
        {
          source_url: finalSourceUrl,
          start_sec: rawStart,
          end_sec: finalEndSec,
          hook: finalHook,
          suggested_title: finalTitle,
          rationale: finalRationale,
          score: finalScore,
        },
      ],
    };
  } else if (req.roleSlug === 'video_editor') {
    const finalDuration =
      ctx.startSec !== undefined &&
      ctx.endSec !== undefined &&
      ctx.endSec > ctx.startSec &&
      ctx.endSec - ctx.startSec <= 60
        ? ctx.endSec - ctx.startSec
        : 45;
    rawOutput = {
      edited_shorts: [
        {
          storage_path: `${ctx.officeId}/${ctx.runId}/short_${vPad}_9x16.mp4`,
          subtitle_path: `${ctx.officeId}/${ctx.runId}/short_${vPad}.srt`,
          duration_sec: finalDuration,
          resolution: '1080x1920',
          suggested_title:
            ctx.suggestedTitle ??
            generatedTitleFallback ??
            `Short #${vNum}/${ctx.totalVideos} #shorts`,
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
            ctx.suggestedTitle ??
            generatedTitleFallback ??
            `Short #${vNum}/${ctx.totalVideos} #shorts`,
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
