import { describe, expect, it } from 'vitest';
import {
  computeOfficeObservabilitySummary,
  evaluateAgentBudgetStatus,
  truncateTracePayload,
  type LlmCallTelemetryRow,
} from '../index.js';

describe('@workoffice/shared — Etapa 8 (Observabilidade, Traces e Controle de Orcamento 80%/100%)', () => {
  it('dispara alerta em 80% do monthly_token_budget e pausa automatica em 100%', () => {
    const okState = evaluateAgentBudgetStatus(350_000, 500_000);
    expect(okState.status).toBe('ok');
    expect(okState.shouldAlert80).toBe(false);
    expect(okState.shouldPause100).toBe(false);

    const warn80 = evaluateAgentBudgetStatus(410_000, 500_000);
    expect(warn80.status).toBe('warning_80');
    expect(warn80.usagePercent).toBe(82);
    expect(warn80.shouldAlert80).toBe(true);
    expect(warn80.shouldPause100).toBe(false);

    const paused100 = evaluateAgentBudgetStatus(500_000, 500_000);
    expect(paused100.status).toBe('exceeded_100');
    expect(paused100.shouldAlert80).toBe(true);
    expect(paused100.shouldPause100).toBe(true);
    expect(paused100.remainingTokens).toBe(0);
  });

  it('garante que os custos e tokens calculados no dashboard batem exatamente com os registros de llm_calls', () => {
    const calls: LlmCallTelemetryRow[] = [
      {
        task_id: 't-1',
        agent_id: 'ag-1',
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        effort: 'low',
        input_tokens: 1000,
        output_tokens: 500,
        reasoning_tokens: 0,
        cost_usd: 0.0028,
        latency_ms: 620,
        error: null,
      },
      {
        task_id: 't-2',
        agent_id: 'ag-2',
        provider: 'google',
        model: 'gemini-2.5-pro',
        effort: 'high',
        input_tokens: 3000,
        output_tokens: 1500,
        reasoning_tokens: 4000,
        cost_usd: 0.05875,
        latency_ms: 1420,
        error: null,
      },
    ];

    const summary = computeOfficeObservabilitySummary({
      calls,
      runsCount: 1,
      publishedShortsCount: 2,
    });

    expect(summary.inputTokens).toBe(4000);
    expect(summary.outputTokens).toBe(2000);
    expect(summary.reasoningTokens).toBe(4000);
    expect(summary.totalTokens).toBe(10000);
    expect(summary.totalCostUsd).toBe(0.06155);
    expect(summary.avgCostPerRunUsd).toBe(0.06155);
    expect(summary.costPerPublishedShortUsd).toBe(0.030775);
    expect(summary.avgLatencyMs).toBe(1020);
    expect(summary.errorRatePercent).toBe(0);
  });

  it('trunca entradas e saidas longas para o inspetor de trace mantendo o JSON completo acessivel', () => {
    const huge = { description: 'A'.repeat(250) };
    const result = truncateTracePayload(huge, 80);
    expect(result.isTruncated).toBe(true);
    expect(result.preview.length).toBeLessThanOrEqual(83);
    expect(result.full).toContain('AAAA');
  });
});
