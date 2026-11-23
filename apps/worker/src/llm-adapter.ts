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
  seo_description?: string;
  seo_tags?: string[];
  subtitle_instructions?: string;
  hook?: string;
  rationale?: string;
  score?: number;
}

interface ParsedVideoEditorLlmJson {
  subtitle_accent_color?: 'yellow' | 'red' | 'white' | 'green';
  highlight_words?: string[];
  apply_dynamic_zoom?: boolean;
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
 *
 * GARANTIA DE PREFLIGHT: Para chaves reais (!wo_test_), valida a chamada da LLM ANTES de executar
 * qualquer ferramenta ou efeito colateral (pesquisa, download, transcricao, corte ou upload YouTube).
 * Se a LLM falhar, encerra imediatamente com erro sem executar a atividade pedida.
 */
export async function runRoleWithMultiProviderLlm(
  req: LlmAdapterRequest,
): Promise<LlmAdapterResult> {
  const startedAt = Date.now();
  const effortCfg = EFFORT_CONFIG_MAP[req.effort];
  const ctx = req.toolContext;

  const isSandboxKey = req.apiKey.startsWith('wo_test_');
  let resolvedModel = req.model;
  let useVertexExpressForGoogle = false;
  let inputTokens = Math.round(1100 * effortCfg.estimatedTokenMultiplier);
  let outputTokens = Math.round(650 * effortCfg.estimatedTokenMultiplier);
  const reasoningTokens =
    effortCfg.thinkingBudgetTokens > 0 ? Math.round(effortCfg.thinkingBudgetTokens * 0.35) : 0;

  await ctx.emitVisualEvent({
    type: 'llm.thinking',
    message: `Processando Vídeo #${ctx.videoIndex}/${ctx.totalVideos} com ${req.provider.toUpperCase()} (${req.model} • esforço ${req.effort})`,
  });

  const invokeAiSdkCall = async (params: {
    targetModel: string;
    system: string;
    prompt: string;
    maxTokens: number;
    includeProviderOpts: boolean;
  }) => {
    const providerModel =
      req.provider === 'anthropic'
        ? createAnthropic({ apiKey: req.apiKey })(params.targetModel)
        : req.provider === 'google'
          ? createGoogleGenerativeAI({ apiKey: req.apiKey })(params.targetModel)
          : createOpenAI({ apiKey: req.apiKey })(params.targetModel);

    return generateText({
      model: providerModel,
      system: params.system,
      prompt: params.prompt,
      maxTokens: params.maxTokens,
      providerOptions: params.includeProviderOpts
        ? (buildProviderSpecificOptions(req.provider, params.targetModel, req.effort) as never)
        : undefined,
      abortSignal: ctx.abortSignal,
    });
  };

  const invokeLlmWithRecovery = async (params: {
    system: string;
    prompt: string;
    maxTokens: number;
    includeProviderOpts: boolean;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }> => {
    if (useVertexExpressForGoogle && req.provider === 'google') {
      return callVertexExpressGenerateContent({
        apiKey: req.apiKey,
        modelId: resolvedModel,
        systemPrompt: params.system,
        prompt: params.prompt,
        maxOutputTokens: params.maxTokens,
        abortSignal: ctx.abortSignal,
      });
    }

    try {
      const llmRes = await invokeAiSdkCall({
        targetModel: resolvedModel,
        system: params.system,
        prompt: params.prompt,
        maxTokens: params.maxTokens,
        includeProviderOpts: params.includeProviderOpts,
      });
      return {
        text: llmRes.text.trim(),
        inputTokens: llmRes.usage?.promptTokens ?? 0,
        outputTokens: llmRes.usage?.completionTokens ?? 0,
      };
    } catch (firstErr) {
      if (ctx.abortSignal?.aborted) {
        throw new Error('Chamada LLM cancelada pelo usuário.');
      }

      if (req.provider === 'anthropic' && isNotFound404Error(firstErr)) {
        const discovery = await discoverActiveAnthropicModel(req.apiKey, resolvedModel);
        if (discovery.selectedModel) {
          resolvedModel = discovery.selectedModel;
          await ctx.emitVisualEvent({
            type: 'llm.thinking',
            message: `Modelo ${req.model} retornou 404 na Anthropic; usando modelo ativo "${resolvedModel}".`,
          });
          try {
            const retryRes = await invokeAiSdkCall({
              targetModel: resolvedModel,
              system: params.system,
              prompt: params.prompt,
              maxTokens: params.maxTokens,
              includeProviderOpts: false,
            });
            return {
              text: retryRes.text.trim(),
              inputTokens: retryRes.usage?.promptTokens ?? 0,
              outputTokens: retryRes.usage?.completionTokens ?? 0,
            };
          } catch (retryErr) {
            const detail = extractErrorStatusAndMessage(retryErr);
            throw new Error(
              `Anthropic falhou com "${req.model}" (404) e também no modelo ativo "${resolvedModel}" (HTTP ${detail.status ?? 'erro'}): ${detail.message}`,
            );
          }
        }
        const detail = extractErrorStatusAndMessage(firstErr);
        throw new Error(
          `Anthropic retornou HTTP 404 para "${req.model}" e nenhum modelo Claude ativo foi encontrado nessa chave (${detail.message}).`,
        );
      }

      if (req.provider === 'openai' && isNotFound404Error(firstErr)) {
        const discovery = await discoverActiveOpenAiModel(req.apiKey, resolvedModel);
        if (discovery.selectedModel) {
          resolvedModel = discovery.selectedModel;
          await ctx.emitVisualEvent({
            type: 'llm.thinking',
            message: `Modelo ${req.model} retornou 404 na OpenAI; usando modelo ativo "${resolvedModel}".`,
          });
          try {
            const retryRes = await invokeAiSdkCall({
              targetModel: resolvedModel,
              system: params.system,
              prompt: params.prompt,
              maxTokens: params.maxTokens,
              includeProviderOpts: false,
            });
            return {
              text: retryRes.text.trim(),
              inputTokens: retryRes.usage?.promptTokens ?? 0,
              outputTokens: retryRes.usage?.completionTokens ?? 0,
            };
          } catch (retryErr) {
            const detail = extractErrorStatusAndMessage(retryErr);
            throw new Error(
              `OpenAI falhou com "${req.model}" (404) e também no modelo ativo "${resolvedModel}" (HTTP ${detail.status ?? 'erro'}): ${detail.message}`,
            );
          }
        }
        const detail = extractErrorStatusAndMessage(firstErr);
        throw new Error(
          `OpenAI retornou HTTP 404 para "${req.model}" e nenhum modelo GPT ativo foi encontrado nessa chave (${detail.message}).`,
        );
      }

      if (req.provider === 'google' && isNotFound404Error(firstErr)) {
        const discovery = await discoverActiveGoogleGeminiModel(req.apiKey, resolvedModel);
        if (discovery.selectedModel) {
          resolvedModel = discovery.selectedModel;
          await ctx.emitVisualEvent({
            type: 'llm.thinking',
            message: `Modelo ${req.model} retornou 404 na chave Google AI Studio; usando modelo ativo "${resolvedModel}".`,
          });
          try {
            const retryRes = await invokeAiSdkCall({
              targetModel: resolvedModel,
              system: params.system,
              prompt: params.prompt,
              maxTokens: params.maxTokens,
              includeProviderOpts: false,
            });
            return {
              text: retryRes.text.trim(),
              inputTokens: retryRes.usage?.promptTokens ?? 0,
              outputTokens: retryRes.usage?.completionTokens ?? 0,
            };
          } catch (retryErr) {
            const detail = extractErrorStatusAndMessage(retryErr);
            throw new Error(
              `Google Gemini falhou com "${req.model}" (404) e também no modelo ativo "${resolvedModel}" (HTTP ${detail.status ?? 'erro'}): ${detail.message}`,
            );
          }
        }

        if (req.apiKey.trim().startsWith('AQ.')) {
          try {
            const vertexRes = await callVertexExpressGenerateContent({
              apiKey: req.apiKey,
              modelId: resolvedModel,
              systemPrompt: params.system,
              prompt: params.prompt,
              maxOutputTokens: params.maxTokens,
              abortSignal: ctx.abortSignal,
            });
            useVertexExpressForGoogle = true;
            return vertexRes;
          } catch (vertexErr) {
            const firstDetail = extractErrorStatusAndMessage(firstErr);
            const vertexDetail = extractErrorStatusAndMessage(vertexErr);
            throw new Error(
              `Google AI Studio retornou HTTP 404 para "${req.model}" (${firstDetail.message}) e Vertex Express também falhou (${vertexDetail.message}). Verifique os modelos ativos na sua chave/projeto no Google AI Studio.`,
            );
          }
        }

        const detail = extractErrorStatusAndMessage(firstErr);
        throw new Error(
          `Google AI Studio retornou HTTP 404 para "${req.model}" e nenhum modelo alternativo com generateContent foi encontrado nessa chave (${detail.message}). Verifique se a chave/projeto tem acesso ativo aos modelos Gemini no Google AI Studio.`,
        );
      }

      const detail = extractErrorStatusAndMessage(firstErr);
      throw new Error(
        `Falha na chamada ${req.provider.toUpperCase()} (${resolvedModel}) [HTTP ${detail.status ?? 'erro'}]: ${detail.message}`,
      );
    }
  };

  // GATEKEEPER OBRIGATORIO: Valida a chamada real da LLM ANTES de executar qualquer ferramenta ou atividade!
  // Se a LLM falhar (ex.: chave Gemini 404/403/401, saldo zerado, etc.), aborta imediatamente com ZERO acoes executadas.
  if (!isSandboxKey) {
    const preflight = await invokeLlmWithRecovery({
      system: 'You are a connectivity check. Reply with OK.',
      prompt: 'OK',
      maxTokens: 24,
      includeProviderOpts: false,
    });
    if (!preflight.text) {
      throw new Error(
        `LLM ${req.provider.toUpperCase()} (${resolvedModel}) retornou resposta vazia no preflight — atividade cancelada antes de iniciar.`,
      );
    }
  }

  // Executa as ferramentas de entrada/preparo somente APOS o preflight da LLM confirmar sucesso!
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
  }

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
        .slice(0, 6)
        .map(
          (v, i) =>
            `${i + 1}. URL: ${v.url} | Título Original: "${v.title}" | Canal: ${v.channelTitle} | Views: ${(v.viewCount ?? 0).toLocaleString('pt-BR')} | Duração: ${v.durationSec}s${v.description ? ` | Resumo: ${v.description.slice(0, 140)}` : ''}`,
        )
        .join('\n');

      rolePrompt = [
        `Pedido do usuário: "${ctx.instruction}" (produzindo Vídeo #${vNum} de ${ctx.totalVideos}).`,
        candidatesList
          ? `Vídeos REAIS mais em alta encontrados no YouTube (ordenados por visualizações):\n${candidatesList}`
          : `URL de origem candidata: ${ctx.sourceUrl ?? 'não encontrada'}`,
        ctx.transcriptText
          ? `Contexto/descrição extraída do vídeo selecionado:\n${ctx.transcriptText.slice(0, 600)}`
          : '',
        `Retorne APENAS um JSON válido (sem markdown, sem comentários) com as chaves exatas:`,
        `{`,
        `  "source_url": "<escolha a URL REAL do vídeo mais em alta e relevante da lista acima>",`,
        `  "start_sec": <numero inteiro em segundos indicando o ponto exato de maior interesse para iniciar o corte>,`,
        `  "end_sec": <numero inteiro em segundos, sendo end_sec - start_sec entre 25 e 58 segundos>,`,
        `  "suggested_title": "<título viral e otimizado para SEO em português para YouTube Shorts com até 85 caracteres terminando com #shorts — NUNCA repita o comando do usuário>",`,
        `  "seo_description": "<descrição completa otimizada para SEO do YouTube Shorts com palavras-chave relevantes sobre o vídeo e 4 a 6 hashtags no final incluindo #shorts>",`,
        `  "seo_tags": ["<tag1>", "<tag2>", "<8 a 15 tags de SEO altamente relevantes sobre o assunto e o criador>"],`,
        `  "hook": "<frase curta de impacto descrevendo o gancho dos 3 primeiros segundos>",`,
        `  "subtitle_instructions": "<orientações VISUAIS sobre as legendas para o Editor: cor de destaque (amarelo, vermelho, verde ou branco), ritmo de cortes/zoom e estilo de destaque — lembrando que o Editor sempre legenda a FALA REAL do vídeo no idioma original>",`,
        `  "rationale": "<por que este vídeo está em alta e por que o trecho start_sec..end_sec é o ponto de maior interesse para retenção>",`,
        `  "score": <nota de retenção de 75 a 99>`,
        `}`,
      ]
        .filter(Boolean)
        .join('\n\n');
    } else if (req.roleSlug === 'video_editor') {
      const cuesPreview = (ctx.spokenSubtitleCues ?? []).slice(0, 45);
      const detectedLang = ctx.detectedVideoLanguage ?? 'original';
      rolePrompt = [
        `Você é o Editor de Vídeo. A transcrição literal da FALA REAL do youtuber (${ctx.startSec ?? 0}s–${ctx.endSec ?? 45}s) JÁ foi extraída automaticamente no idioma original ("${detectedLang}") e será usada diretamente nas legendas do vídeo — NÃO reescreva nem traduza a fala.`,
        `Orientações de estilo de legenda enviadas pelo Roteirista (APENAS para escolher cor, zoom e palavras-chave reais a destacar — JAMAIS serão inseridas como texto na legenda):`,
        `"${ctx.editingInstructions ?? 'Manter ritmo dinâmico e legendas legíveis.'}"`,
        cuesPreview.length > 0
          ? `Falas REAIS transcritas do vídeo (idioma "${detectedLang}"):\n${cuesPreview.map((c) => `- ${c.text}`).join('\n')}`
          : `Nenhuma fala foi detectada no áudio do vídeo.`,
        `Retorne APENAS um JSON válido com as decisões VISUAIS de edição:`,
        `{`,
        `  "subtitle_accent_color": "yellow",`,
        `  "highlight_words": ["<escolha de 2 a 6 palavras EXATAS que aparecem literalmente nas falas acima no idioma ${detectedLang}>"],`,
        `  "apply_dynamic_zoom": true,`,
        `  "suggested_title": "${(ctx.suggestedTitle ?? '').replace(/"/g, "'")}",`,
        `  "editing_notes": "<resumo curto do estilo visual aplicado (cor, zoom, palavras destacadas)>"`,
        `}`,
      ].join('\n\n');
    } else {
      rolePrompt = `Crie um título viral curto (máx 80 caracteres, terminando com #shorts) em português para o Vídeo #${vNum}/${ctx.totalVideos} baseado no tema "${ctx.suggestedTitle ?? ctx.instruction}". Retorne apenas o título.`;
    }

    const mainRes = await invokeLlmWithRecovery({
      system: req.systemPrompt,
      prompt: rolePrompt,
      maxTokens: effectiveMaxTokens,
      includeProviderOpts: true,
    });

    const rawText = mainRes.text;
    if (mainRes.inputTokens > 0) inputTokens = mainRes.inputTokens;
    if (mainRes.outputTokens > 0) outputTokens = mainRes.outputTokens;

    if (!rawText) {
      throw new Error(
        `LLM (${req.provider}/${resolvedModel}) retornou resposta vazia — atividade interrompida.`,
      );
    }

    if (req.roleSlug === 'scriptwriter') {
      parsedScriptJson = tryParseJsonFromLlmText<ParsedScriptwriterLlmJson>(rawText);
    } else if (req.roleSlug === 'video_editor') {
      parsedEditorJson = tryParseJsonFromLlmText<ParsedVideoEditorLlmJson>(rawText);
      if (parsedEditorJson?.suggested_title?.trim()) {
        generatedTitleFallback = parsedEditorJson.suggested_title.trim().slice(0, 95);
      }
    } else {
      generatedTitleFallback = rawText.replace(/^["']|["']$/g, '').slice(0, 95);
      if (generatedTitleFallback && !ctx.suggestedTitle) {
        ctx.suggestedTitle = generatedTitleFallback;
      }
    }

    if (req.roleSlug === 'scriptwriter' && !parsedScriptJson) {
      throw new Error(
        `LLM (${req.provider}/${resolvedModel}) respondeu sem JSON válido para o Roteirista: "${rawText.slice(0, 180)}"`,
      );
    }
  }

  // Publicador executa upload/agendamento SOMENTE APOS a chamada da LLM ter dado certo!
  if (req.roleSlug === 'publisher_analyst') {
    await executeRegisteredTool('youtube_upload_short', {}, ctx);
    await executeRegisteredTool('youtube_schedule_video', {}, ctx);
    await executeRegisteredTool('youtube_fetch_analytics', {}, ctx);
  }

  // 2a fase do Editor: aplica EXCLUSIVAMENTE estilo visual (cor, zoom e destaque em palavras que EXISTEM na fala real)
  // mantendo ctx.spokenSubtitleCues 100% IMUTAVEL (fala verbatim no idioma original) — impossivel vazar instrucoes na legenda!
  if (req.roleSlug === 'video_editor') {
    const allowedColors = new Set(['yellow', 'red', 'white', 'green']);
    const inferredColorFromInstructions = /vermelh|red/i.test(ctx.editingInstructions ?? '')
      ? 'red'
      : /verde|green/i.test(ctx.editingInstructions ?? '')
        ? 'green'
        : 'yellow';

    const spokenTranscriptLower = (ctx.spokenSubtitleCues ?? [])
      .map((c) => c.text.toLowerCase())
      .join(' ');

    const verifiedHighlightWords = Array.isArray(parsedEditorJson?.highlight_words)
      ? parsedEditorJson.highlight_words
          .map((w) => String(w).trim())
          .filter(
            (w) =>
              w.length >= 2 &&
              spokenTranscriptLower.includes(w.toLowerCase()),
          )
          .slice(0, 8)
      : [];

    ctx.subtitleStyle = {
      accentColor:
        parsedEditorJson?.subtitle_accent_color &&
        allowedColors.has(parsedEditorJson.subtitle_accent_color)
          ? parsedEditorJson.subtitle_accent_color
          : inferredColorFromInstructions,
      highlightWords: verifiedHighlightWords,
      applyDynamicZoom:
        typeof parsedEditorJson?.apply_dynamic_zoom === 'boolean'
          ? parsedEditorJson.apply_dynamic_zoom
          : /zoom/i.test(ctx.editingInstructions ?? ''),
    };

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

    const finalSeoTags =
      Array.isArray(parsedScriptJson?.seo_tags) && parsedScriptJson.seo_tags.length > 0
        ? parsedScriptJson.seo_tags
            .map((t) => String(t).replace(/^#/, '').trim())
            .filter((t) => t.length >= 2)
            .slice(0, 15)
        : ['shorts', 'youtube shorts', 'viral', ctx.sourceChannelName ?? 'youtube'].filter(Boolean);

    const finalSeoDescription =
      parsedScriptJson?.seo_description?.trim() ||
      `${finalHook}\n\nTrecho em destaque de "${ctx.sourceVideoTitle ?? ctx.instruction}" (${ctx.sourceChannelName ?? 'YouTube'}).\n\n${finalSeoTags
        .slice(0, 5)
        .map((t) => `#${t.replace(/\s+/g, '')}`)
        .join(' ')} #shorts`;

    const finalSubtitleInstructions =
      parsedScriptJson?.subtitle_instructions?.trim() ||
      'Aplicar legendas dinâmicas na fala real no idioma original do vídeo, destacando palavras-chave de impacto em amarelo vibrante e usando zoom sutil na abertura.';

    const finalRationale =
      parsedScriptJson?.rationale?.trim() ||
      `Trecho de maior interesse extraído de "${ctx.sourceVideoTitle ?? finalSourceUrl}" (${ctx.sourceChannelName ?? 'YouTube'}) entre ${rawStart}s e ${finalEndSec}s.`;

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
          seo_description: finalSeoDescription,
          seo_tags: finalSeoTags,
          subtitle_instructions: finalSubtitleInstructions,
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
          ...(ctx.seoDescription ? { seo_description: ctx.seoDescription } : {}),
          ...(ctx.seoTags && ctx.seoTags.length > 0 ? { seo_tags: ctx.seoTags } : {}),
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
          visibility: uploaded?.visibility ?? 'public',
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
