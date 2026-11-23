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
  resolvedModel: string;
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

interface ParsedVideoEditorLlmJson {
  subtitle_accent_color?: 'yellow' | 'red' | 'white' | 'green';
  highlight_words?: string[];
  apply_dynamic_zoom?: boolean;
  polished_cues?: { startSec: number; endSec: number; text: string }[];
  suggested_title?: string;
  editing_notes?: string;
}

function tryParseJsonFromLlmText<T = ParsedScriptwriterLlmJson>(text: string): T | null {
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
    return JSON.parse(cleaned.slice(startIdx, endIdx + 1)) as T;
  } catch {
    return null;
  }
}

function extractErrorStatusAndMessage(err: unknown): { status?: number; message: string } {
  const e = err as {
    statusCode?: number;
    status?: number;
    responseBody?: string;
    message?: string;
    lastError?: { statusCode?: number; status?: number; responseBody?: string; message?: string };
    cause?: { statusCode?: number; status?: number; responseBody?: string; message?: string };
  };
  const status =
    e?.statusCode ??
    e?.status ??
    e?.lastError?.statusCode ??
    e?.lastError?.status ??
    e?.cause?.statusCode ??
    e?.cause?.status;
  const body = e?.responseBody ?? e?.lastError?.responseBody ?? e?.cause?.responseBody;
  const baseMsg = e?.lastError?.message ?? e?.message ?? String(err);
  const rawMsg = body ? `${baseMsg} | ${String(body).slice(0, 320)}` : baseMsg;
  return { status, message: rawMsg };
}

function isNotFound404Error(err: unknown): boolean {
  const { status, message } = extractErrorStatusAndMessage(err);
  return (
    status === 404 ||
    /\b404\b|not_found|is not found for api version|models\/.+ not found/i.test(message)
  );
}

/**
 * Consulta GET /v1beta/models na Google AI Studio usando a propria chave do agente
 * e escolhe automaticamente o melhor modelo Gemini ativo que suporta generateContent.
 * Evita erros 404 quando um modelo antigo (ex: gemini-2.5-pro / gemini-2.5-flash) foi
 * descontinuado ou nao esta disponivel no tier gratuito daquela chave.
 */
export async function discoverActiveGoogleGeminiModel(
  apiKey: string,
  requestedModel: string,
): Promise<{ selectedModel: string | null; availableModels: string[] }> {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey.trim(),
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { selectedModel: null, availableModels: [] };
    }

    const data = (await res.json()) as {
      models?: {
        name?: string;
        supportedGenerationMethods?: string[];
      }[];
    };

    const excludedPattern =
      /embedding|imagen|veo|tts|audio|live|aqa|bison|gecko|robotics|computer-use|learnlm|gemma|banana/i;

    const availableModels = (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => String(m.name ?? '').replace(/^models\//, '').trim())
      .filter((id) => id.startsWith('gemini-') && !excludedPattern.test(id));

    if (availableModels.length === 0) {
      return { selectedModel: null, availableModels: [] };
    }

    const wantsPro = requestedModel.toLowerCase().includes('pro');

    const scoreModel = (id: string): number => {
      const lower = id.toLowerCase();
      let score = 0;
      if (lower === requestedModel.toLowerCase()) score -= 1000; // Ja falhou com 404!
      if (wantsPro && lower.includes('pro')) score += 40;
      if (!wantsPro && lower.includes('flash')) score += 40;
      if (lower.includes('flash')) score += 20;
      if (lower.includes('latest')) score += 15;
      if (lower.includes('exp') || lower.includes('preview')) score -= 5;
      const verMatch = lower.match(/gemini-(\d+(?:\.\d+)?)/);
      if (verMatch?.[1]) {
        score += Number(verMatch[1]) * 10;
      }
      return score;
    };

    const ranked = [...availableModels].sort((a, b) => scoreModel(b) - scoreModel(a));
    const best = ranked.find((id) => id !== requestedModel) ?? ranked[0] ?? null;
    return { selectedModel: best, availableModels };
  } catch {
    return { selectedModel: null, availableModels: [] };
  }
}

/**
 * Consulta GET /v1/models na Anthropic usando a propria chave do agente para recuperar
 * automaticamente de HTTP 404 (ex: modelos aposentados como claude-3-5-haiku-latest).
 */
export async function discoverActiveAnthropicModel(
  apiKey: string,
  requestedModel: string,
): Promise<{ selectedModel: string | null; availableModels: string[] }> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { selectedModel: null, availableModels: [] };
    }

    const data = (await res.json()) as {
      data?: { id?: string }[];
    };

    const availableModels = (data.data ?? [])
      .map((m) => String(m.id ?? '').trim())
      .filter((id) => id.startsWith('claude-'));

    if (availableModels.length === 0) {
      return { selectedModel: null, availableModels: [] };
    }

    const reqLower = requestedModel.toLowerCase();
    const wantsHaiku = reqLower.includes('haiku');
    const wantsOpus = reqLower.includes('opus');
    const wantsSonnet = reqLower.includes('sonnet');

    const scoreModel = (id: string): number => {
      const lower = id.toLowerCase();
      let score = 0;
      if (lower === reqLower) score -= 1000;
      if (wantsHaiku && lower.includes('haiku')) score += 50;
      if (wantsSonnet && lower.includes('sonnet')) score += 50;
      if (wantsOpus && lower.includes('opus')) score += 50;
      if (lower.includes('4-5') || lower.includes('4.5')) score += 30;
      if (lower.includes('4-6') || lower.includes('4.6')) score += 35;
      if (lower.includes('-4-')) score += 20;
      return score;
    };

    const ranked = [...availableModels].sort((a, b) => scoreModel(b) - scoreModel(a));
    const best = ranked.find((id) => id !== requestedModel) ?? ranked[0] ?? null;
    return { selectedModel: best, availableModels };
  } catch {
    return { selectedModel: null, availableModels: [] };
  }
}

/**
 * Consulta GET /v1/models na OpenAI para recuperar automaticamente de HTTP 404.
 */
export async function discoverActiveOpenAiModel(
  apiKey: string,
  requestedModel: string,
): Promise<{ selectedModel: string | null; availableModels: string[] }> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { selectedModel: null, availableModels: [] };
    }

    const data = (await res.json()) as { data?: { id?: string }[] };
    const availableModels = (data.data ?? [])
      .map((m) => String(m.id ?? '').trim())
      .filter((id) => /^gpt-(?:4\.1|4o|5)/.test(id) && !/audio|realtime|image|tts|transcribe/i.test(id));

    if (availableModels.length === 0) {
      return { selectedModel: null, availableModels: [] };
    }

    const wantsMini = requestedModel.toLowerCase().includes('mini');
    const ranked = [...availableModels].sort((a, b) => {
      const aMini = a.includes('mini') ? 1 : 0;
      const bMini = b.includes('mini') ? 1 : 0;
      if (wantsMini && aMini !== bMini) return bMini - aMini;
      return b.localeCompare(a);
    });
    const best = ranked.find((id) => id !== requestedModel) ?? ranked[0] ?? null;
    return { selectedModel: best, availableModels };
  } catch {
    return { selectedModel: null, availableModels: [] };
  }
}

/**
 * Fallback explicito para chaves Google Cloud Vertex AI Express Mode (prefixo AQ.)
 * caso o endpoint generativelanguage.googleapis.com retorne 404.
 */
async function callVertexExpressGenerateContent(params: {
  apiKey: string;
  modelId: string;
  systemPrompt: string;
  prompt: string;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(params.modelId)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': params.apiKey.trim(),
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: params.systemPrompt }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: params.prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: params.maxOutputTokens,
      },
    }),
    signal: params.abortSignal ?? AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Vertex Express HTTP ${res.status} (${params.modelId}): ${body.slice(0, 260)}`);
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();

  return {
    text,
    inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
  };
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
    // 1a fase do Editor: baixa o trecho real e transcreve a FALA REAL do video no idioma original
    // ANTES de chamar o LLM Editor (para o LLM revisar estilo/destaques seguindo o roteirista sem inventar falas!)
    await executeRegisteredTool('download_video_segment', {}, ctx);
    await executeRegisteredTool('transcribe_audio', {}, ctx);
  } else if (req.roleSlug === 'publisher_analyst') {
    await executeRegisteredTool('youtube_upload_short', {}, ctx);
    await executeRegisteredTool('youtube_schedule_video', {}, ctx);
    await executeRegisteredTool('youtube_fetch_analytics', {}, ctx);
  }

  const isSandboxKey = req.apiKey.startsWith('wo_test_');
  let resolvedModel = req.model;
  let inputTokens = Math.round(1100 * effortCfg.estimatedTokenMultiplier);
  let outputTokens = Math.round(650 * effortCfg.estimatedTokenMultiplier);
  const reasoningTokens =
    effortCfg.thinkingBudgetTokens > 0 ? Math.round(effortCfg.thinkingBudgetTokens * 0.35) : 0;

  let parsedScriptJson: ParsedScriptwriterLlmJson | null = null;
  let parsedEditorJson: ParsedVideoEditorLlmJson | null = null;
  let generatedTitleFallback: string | null = null;

  if (!isSandboxKey) {
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
    } else if (req.roleSlug === 'video_editor') {
      const cuesPreview = (ctx.spokenSubtitleCues ?? []).slice(0, 45);
      const detectedLang = ctx.detectedVideoLanguage ?? 'original';
      rolePrompt = [
        `Você recebeu a transcrição da FALA REAL do youtuber no corte (${ctx.startSec ?? 0}s–${ctx.endSec ?? 45}s) e as instruções de edição do Roteirista.`,
        `Idioma original falado no vídeo: "${detectedLang}".`,
        `Instruções do Roteirista (APENAS para estilo visual, ritmo, zoom e destaques — JAMAIS coloque essas instruções dentro da legenda!):`,
        `"${ctx.editingInstructions ?? 'Manter ritmo dinâmico e legendas legíveis.'}"`,
        cuesPreview.length > 0
          ? `Falas reais extraídas do áudio do vídeo (JSON):\n${JSON.stringify(cuesPreview)}`
          : `Nenhuma fala foi detectada no áudio do vídeo.`,
        `REGRAS OBRIGATÓRIAS:`,
        `1. JAMAIS insira instruções do roteirista (como "abra com zoom", "cortes dinâmicos", "destaque em vermelho") no texto das legendas.`,
        `2. MANTENHA 100% O IDIOMA ORIGINAL DO VÍDEO ("${detectedLang}"): se o youtuber fala em português, legende em português; se fala em inglês, legende em inglês. NUNCA traduza.`,
        `3. Em "polished_cues", devolva EXATAMENTE a mesma quantidade de blocos e os mesmos timestamps (startSec/endSec), fazendo apenas correção mínima de pontuação/grafia na fala real transcrita (ou lista vazia se não houver falas).`,
        `4. Em "highlight_words", liste de 2 a 6 palavras/expressões REAIS que aparecem nas falas acima (no idioma original "${detectedLang}") para destacar conforme o estilo pedido pelo roteirista.`,
        `5. Em "subtitle_accent_color", escolha "red", "yellow", "green" ou "white" seguindo o pedido do roteirista (padrão "yellow").`,
        `Retorne APENAS um JSON válido:`,
        `{`,
        `  "subtitle_accent_color": "yellow",`,
        `  "highlight_words": ["..."],`,
        `  "apply_dynamic_zoom": true,`,
        `  "suggested_title": "${(ctx.suggestedTitle ?? '').replace(/"/g, "'")}",`,
        `  "editing_notes": "<resumo curto do estilo aplicado>",`,
        `  "polished_cues": [{"startSec": 0, "endSec": 2.5, "text": "<fala real no idioma original>"}]`,
        `}`,
      ].join('\n\n');
    } else {
      rolePrompt = `Crie um título viral curto (máx 80 caracteres, terminando com #shorts) em português para o Vídeo #${vNum}/${ctx.totalVideos} baseado no tema "${ctx.suggestedTitle ?? ctx.instruction}". Retorne apenas o título.`;
    }

    const invokeAiSdk = async (targetModel: string, includeProviderOpts: boolean) => {
      const providerModel =
        req.provider === 'anthropic'
          ? createAnthropic({ apiKey: req.apiKey })(targetModel)
          : req.provider === 'google'
            ? createGoogleGenerativeAI({ apiKey: req.apiKey })(targetModel)
            : createOpenAI({ apiKey: req.apiKey })(targetModel);

      return generateText({
        model: providerModel,
        system: req.systemPrompt,
        prompt: rolePrompt,
        maxTokens: effectiveMaxTokens,
        providerOptions: includeProviderOpts
          ? (buildProviderSpecificOptions(req.provider, targetModel, req.effort) as never)
          : undefined,
        abortSignal: ctx.abortSignal,
      });
    };

    let rawText = '';
    try {
      const llmRes = await invokeAiSdk(resolvedModel, true);
      rawText = llmRes.text.trim();
      if (llmRes.usage) {
        inputTokens = llmRes.usage.promptTokens || inputTokens;
        outputTokens = llmRes.usage.completionTokens || outputTokens;
      }
    } catch (firstErr) {
      if (ctx.abortSignal?.aborted) {
        throw new Error('Chamada LLM cancelada pelo usuário.');
      }

      // Auto-recuperacao para Anthropic Claude 404 (ex: claude-3-5-haiku-latest aposentado em 2026)
      if (req.provider === 'anthropic' && isNotFound404Error(firstErr)) {
        const discovery = await discoverActiveAnthropicModel(req.apiKey, resolvedModel);
        if (discovery.selectedModel) {
          resolvedModel = discovery.selectedModel;
          await ctx.emitVisualEvent({
            type: 'llm.thinking',
            message: `Modelo ${req.model} retornou 404 na Anthropic; usando modelo ativo "${resolvedModel}".`,
          });
          try {
            const retryRes = await invokeAiSdk(resolvedModel, false);
            rawText = retryRes.text.trim();
            if (retryRes.usage) {
              inputTokens = retryRes.usage.promptTokens || inputTokens;
              outputTokens = retryRes.usage.completionTokens || outputTokens;
            }
          } catch (retryErr) {
            const detail = extractErrorStatusAndMessage(retryErr);
            throw new Error(
              `Anthropic falhou com "${req.model}" (404) e também no modelo ativo "${resolvedModel}" (HTTP ${detail.status ?? 'erro'}): ${detail.message}`,
            );
          }
        } else {
          const detail = extractErrorStatusAndMessage(firstErr);
          throw new Error(
            `Anthropic retornou HTTP 404 para "${req.model}" e nenhum modelo Claude ativo foi encontrado nessa chave (${detail.message}).`,
          );
        }
      } else if (req.provider === 'openai' && isNotFound404Error(firstErr)) {
        const discovery = await discoverActiveOpenAiModel(req.apiKey, resolvedModel);
        if (discovery.selectedModel) {
          resolvedModel = discovery.selectedModel;
          await ctx.emitVisualEvent({
            type: 'llm.thinking',
            message: `Modelo ${req.model} retornou 404 na OpenAI; usando modelo ativo "${resolvedModel}".`,
          });
          try {
            const retryRes = await invokeAiSdk(resolvedModel, false);
            rawText = retryRes.text.trim();
            if (retryRes.usage) {
              inputTokens = retryRes.usage.promptTokens || inputTokens;
              outputTokens = retryRes.usage.completionTokens || outputTokens;
            }
          } catch (retryErr) {
            const detail = extractErrorStatusAndMessage(retryErr);
            throw new Error(
              `OpenAI falhou com "${req.model}" (404) e também no modelo ativo "${resolvedModel}" (HTTP ${detail.status ?? 'erro'}): ${detail.message}`,
            );
          }
        } else {
          const detail = extractErrorStatusAndMessage(firstErr);
          throw new Error(
            `OpenAI retornou HTTP 404 para "${req.model}" e nenhum modelo GPT ativo foi encontrado nessa chave (${detail.message}).`,
          );
        }
      } else if (req.provider === 'google' && isNotFound404Error(firstErr)) {
        const discovery = await discoverActiveGoogleGeminiModel(req.apiKey, resolvedModel);

        if (discovery.selectedModel) {
          resolvedModel = discovery.selectedModel;
          await ctx.emitVisualEvent({
            type: 'llm.thinking',
            message: `Modelo ${req.model} retornou 404 na chave Google AI Studio; usando modelo ativo "${resolvedModel}".`,
          });

          try {
            const retryRes = await invokeAiSdk(resolvedModel, false);
            rawText = retryRes.text.trim();
            if (retryRes.usage) {
              inputTokens = retryRes.usage.promptTokens || inputTokens;
              outputTokens = retryRes.usage.completionTokens || outputTokens;
            }
          } catch (retryErr) {
            const detail = extractErrorStatusAndMessage(retryErr);
            throw new Error(
              `Google Gemini falhou com "${req.model}" (404) e também no modelo ativo "${resolvedModel}" (HTTP ${detail.status ?? 'erro'}): ${detail.message}`,
            );
          }
        } else if (req.apiKey.trim().startsWith('AQ.')) {
          try {
            const vertexRes = await callVertexExpressGenerateContent({
              apiKey: req.apiKey,
              modelId: resolvedModel,
              systemPrompt: req.systemPrompt,
              prompt: rolePrompt,
              maxOutputTokens: effectiveMaxTokens,
              abortSignal: ctx.abortSignal,
            });
            rawText = vertexRes.text;
            if (vertexRes.inputTokens > 0) inputTokens = vertexRes.inputTokens;
            if (vertexRes.outputTokens > 0) outputTokens = vertexRes.outputTokens;
          } catch (vertexErr) {
            const firstDetail = extractErrorStatusAndMessage(firstErr);
            const vertexDetail = extractErrorStatusAndMessage(vertexErr);
            throw new Error(
              `Google AI Studio retornou HTTP 404 para "${req.model}" (${firstDetail.message}) e Vertex Express também falhou (${vertexDetail.message}). Verifique os modelos ativos na sua chave/projeto no Google AI Studio.`,
            );
          }
        } else {
          const detail = extractErrorStatusAndMessage(firstErr);
          throw new Error(
            `Google AI Studio retornou HTTP 404 para "${req.model}" e nenhum modelo alternativo com generateContent foi encontrado nessa chave (${detail.message}). Verifique se a chave/projeto tem acesso ativo aos modelos Gemini no Google AI Studio.`,
          );
        }
      } else {
        const detail = extractErrorStatusAndMessage(firstErr);
        throw new Error(
          `Falha na chamada ${req.provider.toUpperCase()} (${req.model}) [HTTP ${detail.status ?? 'erro'}]: ${detail.message}`,
        );
      }
    }

    if (rawText) {
      if (req.roleSlug === 'scriptwriter') {
        parsedScriptJson = tryParseJsonFromLlmText<ParsedScriptwriterLlmJson>(rawText);
      } else if (req.roleSlug === 'video_editor') {
        parsedEditorJson = tryParseJsonFromLlmText<ParsedVideoEditorLlmJson>(rawText);
        if (parsedEditorJson?.suggested_title?.trim()) {
          generatedTitleFallback = parsedEditorJson.suggested_title.trim().slice(0, 95);
        }
      } else {
        generatedTitleFallback = rawText.replace(/^["']|["']$/g, '').slice(0, 95);
      }
    }

    if (req.roleSlug === 'scriptwriter' && !parsedScriptJson) {
      throw new Error(
        `LLM (${req.provider}/${resolvedModel}) respondeu sem JSON válido para o Roteirista: "${rawText.slice(0, 180)}"`,
      );
    }
  }

  // 2a fase do Editor: aplica estilo/destaques decididos pelo LLM Editor sobre a FALA REAL transcrita
  // e executa corte 9:16 + burn-in de legendas reais + upload no Storage!
  if (req.roleSlug === 'video_editor') {
    const allowedColors = new Set(['yellow', 'red', 'white', 'green']);
    const inferredColorFromInstructions = /vermelh|red/i.test(ctx.editingInstructions ?? '')
      ? 'red'
      : /verde|green/i.test(ctx.editingInstructions ?? '')
        ? 'green'
        : 'yellow';

    ctx.subtitleStyle = {
      accentColor:
        parsedEditorJson?.subtitle_accent_color &&
        allowedColors.has(parsedEditorJson.subtitle_accent_color)
          ? parsedEditorJson.subtitle_accent_color
          : inferredColorFromInstructions,
      highlightWords: Array.isArray(parsedEditorJson?.highlight_words)
        ? parsedEditorJson.highlight_words
            .map((w) => String(w).trim())
            .filter((w) => w.length >= 2)
            .slice(0, 8)
        : [],
      applyDynamicZoom:
        typeof parsedEditorJson?.apply_dynamic_zoom === 'boolean'
          ? parsedEditorJson.apply_dynamic_zoom
          : /zoom/i.test(ctx.editingInstructions ?? ''),
    };

    // Aceita polished_cues SOMENTE se mantiver o mesmo numero de blocos e nao vazar instrucoes de edicao!
    const origCues = ctx.spokenSubtitleCues ?? [];
    const candidatePolished = parsedEditorJson?.polished_cues;
    if (
      origCues.length > 0 &&
      Array.isArray(candidatePolished) &&
      candidatePolished.length === origCues.length
    ) {
      const directorLeakPattern =
        /abra com zoom|cortes din[aâ]micos|destaque em vermelho|ritmo acelerado|transi[cç][õo]es de/i;
      const allClean = candidatePolished.every(
        (c) =>
          typeof c.text === 'string' &&
          c.text.trim().length > 0 &&
          !directorLeakPattern.test(c.text),
      );
      if (allClean) {
        ctx.spokenSubtitleCues = origCues.map((orig, idx) => ({
          startSec: orig.startSec,
          endSec: orig.endSec,
          text: candidatePolished[idx]!.text.trim(),
        }));
      }
    }

    await executeRegisteredTool('cut_vertical_short', {}, ctx);
    await executeRegisteredTool('burn_subtitles', {}, ctx);
    await executeRegisteredTool('upload_artifact', {}, ctx);
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
      llmChosenUrl ??
      ctx.sourceUrl ??
      (isSandboxKey ? `https://www.youtube.com/watch?v=source_${vPad}` : undefined);

    if (!finalSourceUrl) {
      throw new Error(
        `Roteirista não obteve nenhuma URL real do YouTube para "${ctx.instruction}" (fallback mockup bloqueado em produção).`,
      );
    }

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
  const costUsd = calculateLlmCallCostUsd(resolvedModel, inputTokens, outputTokens, reasoningTokens);

  return {
    rawOutput,
    resolvedModel,
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
