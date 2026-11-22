export interface LlmCallTelemetryRow {
  id?: string;
  task_id: string;
  agent_id: string;
  provider: string;
  model: string;
  effort: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  latency_ms: number;
  error?: string | null;
  created_at?: string;
}

export interface AgentBudgetEvaluation {
  status: 'ok' | 'warning_80' | 'exceeded_100';
  tokensUsed: number;
  monthlyTokenBudget: number | null;
  usageRatio: number;
  usagePercent: number;
  remainingTokens: number | null;
  shouldAlert80: boolean;
  shouldPause100: boolean;
}

/**
 * Avalia o consumo mensal de tokens de um agente frente ao seu monthly_token_budget:
 * - >= 80% dispara alerta visual (warning_80)
 * - >= 100% dispara pausa automatica na copa (exceeded_100 -> budget.exceeded)
 */
export function evaluateAgentBudgetStatus(
  tokensUsed: number,
  monthlyTokenBudget: number | null | undefined,
): AgentBudgetEvaluation {
  const safeUsed = Math.max(0, Math.round(tokensUsed));
  if (!monthlyTokenBudget || monthlyTokenBudget <= 0) {
    return {
      status: 'ok',
      tokensUsed: safeUsed,
      monthlyTokenBudget: null,
      usageRatio: 0,
      usagePercent: 0,
      remainingTokens: null,
      shouldAlert80: false,
      shouldPause100: false,
    };
  }

  const ratio = safeUsed / monthlyTokenBudget;
  const percent = Number((ratio * 100).toFixed(1));
  const remaining = Math.max(0, monthlyTokenBudget - safeUsed);

  if (ratio >= 1.0) {
    return {
      status: 'exceeded_100',
      tokensUsed: safeUsed,
      monthlyTokenBudget,
      usageRatio: ratio,
      usagePercent: percent,
      remainingTokens: 0,
      shouldAlert80: true,
      shouldPause100: true,
    };
  }

  if (ratio >= 0.8) {
    return {
      status: 'warning_80',
      tokensUsed: safeUsed,
      monthlyTokenBudget,
      usageRatio: ratio,
      usagePercent: percent,
      remainingTokens: remaining,
      shouldAlert80: true,
      shouldPause100: false,
    };
  }

  return {
    status: 'ok',
    tokensUsed: safeUsed,
    monthlyTokenBudget,
    usageRatio: ratio,
    usagePercent: percent,
    remainingTokens: remaining,
    shouldAlert80: false,
    shouldPause100: false,
  };
}

export interface AggregatedTelemetryMetrics {
  callsCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  errorCount: number;
  errorRatePercent: number;
}

export function computeTelemetryMetricsFromCalls(
  calls: readonly LlmCallTelemetryRow[],
): AggregatedTelemetryMetrics {
  if (calls.length === 0) {
    return {
      callsCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      errorCount: 0,
      errorRatePercent: 0,
    };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalCostUsd = 0;
  let totalLatency = 0;
  let errorCount = 0;
  const latencies: number[] = [];

  for (const c of calls) {
    inputTokens += Number(c.input_tokens ?? 0);
    outputTokens += Number(c.output_tokens ?? 0);
    reasoningTokens += Number(c.reasoning_tokens ?? 0);
    totalCostUsd += Number(c.cost_usd ?? 0);
    const lat = Math.max(0, Number(c.latency_ms ?? 0));
    totalLatency += lat;
    latencies.push(lat);
    if (c.error) {
      errorCount++;
    }
  }

  latencies.sort((a, b) => a - b);
  const p95Idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
  const p95LatencyMs = latencies[p95Idx] ?? 0;

  return {
    callsCount: calls.length,
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    avgLatencyMs: Math.round(totalLatency / calls.length),
    p95LatencyMs: Math.round(p95LatencyMs),
    errorCount,
    errorRatePercent: Number(((errorCount / calls.length) * 100).toFixed(1)),
  };
}

export interface OfficeObservabilitySummary extends AggregatedTelemetryMetrics {
  runsCount: number;
  publishedShortsCount: number;
  avgCostPerRunUsd: number;
  costPerPublishedShortUsd: number;
}

export function computeOfficeObservabilitySummary(params: {
  calls: readonly LlmCallTelemetryRow[];
  runsCount: number;
  publishedShortsCount: number;
}): OfficeObservabilitySummary {
  const base = computeTelemetryMetricsFromCalls(params.calls);
  const safeRuns = Math.max(1, params.runsCount);
  const safeShorts = Math.max(1, params.publishedShortsCount);

  return {
    ...base,
    runsCount: params.runsCount,
    publishedShortsCount: params.publishedShortsCount,
    avgCostPerRunUsd: Number((base.totalCostUsd / safeRuns).toFixed(6)),
    costPerPublishedShortUsd: Number((base.totalCostUsd / safeShorts).toFixed(6)),
  };
}

export function truncateTracePayload(
  payload: unknown,
  maxLength = 160,
): { preview: string; full: string; isTruncated: boolean } {
  const full =
    typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}, null, 2);
  const singleLine = full.replace(/\s+/g, ' ').trim();

  if (singleLine.length <= maxLength) {
    return {
      preview: singleLine,
      full,
      isTruncated: false,
    };
  }

  return {
    preview: `${singleLine.slice(0, maxLength)}...`,
    full,
    isTruncated: true,
  };
}
