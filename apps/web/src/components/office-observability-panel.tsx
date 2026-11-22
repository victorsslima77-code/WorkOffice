'use client';

import {
  computeOfficeObservabilitySummary,
  computeTelemetryMetricsFromCalls,
  evaluateAgentBudgetStatus,
  type LlmCallTelemetryRow,
  type VisualOfficeAgent,
} from '@workoffice/shared';
import { useEffect, useState } from 'react';

export interface TraceTaskItem {
  id: string;
  agent_id: string;
  agent_name: string;
  role_name: string;
  role_slug: string;
  allowed_tools?: string[];
  status: string;
  attempts: number;
  input: unknown;
  output: unknown;
  error_message?: string | null;
  created_at: string;
}

interface WorkerHealthInfo {
  worker_id: string;
  status: 'online' | 'busy' | 'offline';
  active_tasks: number;
  last_seen_at: string;
}

interface OfficeObservabilityPanelProps {
  officeId?: string;
  agents: readonly VisualOfficeAgent[];
  syntheticCalls: readonly LlmCallTelemetryRow[];
  syntheticTasks?: readonly TraceTaskItem[];
  publishedShortsCount: number;
  runsCount: number;
  onTriggerBudgetAction: (agentId: string, action: 'hit_80' | 'hit_100' | 'restore') => void;
}

export function OfficeObservabilityPanel({
  officeId,
  agents,
  syntheticCalls,
  publishedShortsCount,
  runsCount,
  onTriggerBudgetAction,
}: OfficeObservabilityPanelProps) {
  const [dbCalls, setDbCalls] = useState<LlmCallTelemetryRow[]>([]);
  const [dbPendingQueue, setDbPendingQueue] = useState(0);
  const [dbRunsCount, setDbRunsCount] = useState(0);
  const [dbPublishedCount, setDbPublishedCount] = useState(0);
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthInfo>({
    worker_id: 'in-process-realtime-stepper',
    status: 'online',
    active_tasks: 0,
    last_seen_at: new Date().toISOString(),
  });
  const [budgetSimLoadingId, setBudgetSimLoadingId] = useState<string | null>(null);

  async function refreshObservabilityFromDb() {
    if (!officeId) return;
    try {
      const res = await fetch(`/api/observability?officeId=${encodeURIComponent(officeId)}`);
      const data = await res.json();
      if (res.ok && data.dashboard) {
        setDbCalls(data.dashboard.llm_calls ?? []);
        setDbPendingQueue(Number(data.dashboard.pending_queue_count ?? 0));
        setDbRunsCount(Number(data.dashboard.runs_count ?? 0));
        setDbPublishedCount(Number(data.dashboard.published_shorts_count ?? 0));
        if (data.dashboard.worker_health) {
          setWorkerHealth(data.dashboard.worker_health);
        }
      }
    } catch {
      // Mantem telemetria em memoria
    }
  }

  useEffect(() => {
    void refreshObservabilityFromDb();
  }, [officeId, syntheticCalls.length]);

  const activeCalls = [...syntheticCalls, ...dbCalls];
  const effectiveRunsCount = Math.max(runsCount, dbRunsCount, 1);
  const effectiveShortsCount = Math.max(publishedShortsCount, dbPublishedCount, 1);

  const officeSummary = computeOfficeObservabilitySummary({
    calls: activeCalls,
    runsCount: effectiveRunsCount,
    publishedShortsCount: effectiveShortsCount,
  });

  async function handleBudgetButton(
    agentId: string,
    action: 'hit_80' | 'hit_100' | 'restore',
  ) {
    setBudgetSimLoadingId(`${agentId}_${action}`);
    try {
      if (officeId) {
        await fetch('/api/observability', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ officeId, agentId, action }),
        });
        await refreshObservabilityFromDb();
      }
      onTriggerBudgetAction(agentId, action);
    } finally {
      setBudgetSimLoadingId(null);
    }
  }

  return (
    <section className="space-y-4 border-2 border-slate-700 bg-slate-900 p-5">
      {/* 1. Cabecalho de Observabilidade + Saude do Worker e Fila Pendente */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
            Observabilidade &amp; Controle de Orçamento
          </span>
          <h2 className="text-lg font-bold text-white">
            Telemetria de Agentes, Custos (`llm_calls`) e Limites Mensais
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-2 border border-emerald-500/50 bg-emerald-950/40 px-3 py-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
            <span className="font-bold uppercase text-emerald-300">
              Worker: {workerHealth.status.toUpperCase()}
            </span>
            <span className="text-slate-400">({workerHealth.worker_id})</span>
          </div>

          <div className="border border-slate-700 bg-slate-950 px-3 py-1.5">
            <span className="text-slate-400">Fila Pendente (`pgmq`): </span>
            <strong className="text-amber-300">{dbPendingQueue} tasks</strong>
          </div>
        </div>
      </div>

      {/* 2. KPIs Consolidados do Escritorio (batendo exatamente com llm_calls) */}
      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
        <div className="border border-slate-800 bg-slate-950 p-3">
          <div className="text-[10px] uppercase text-slate-400">Tokens (In / Out / Reason)</div>
          <div className="mt-1 font-mono text-sm font-bold text-white">
            {officeSummary.totalTokens.toLocaleString()} tok
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400">
            In: {officeSummary.inputTokens.toLocaleString()} • Out:{' '}
            {officeSummary.outputTokens.toLocaleString()} • R:{' '}
            {officeSummary.reasoningTokens.toLocaleString()}
          </div>
        </div>

        <div className="border border-slate-800 bg-slate-950 p-3">
          <div className="text-[10px] uppercase text-slate-400">Custo Total (`llm_calls`)</div>
          <div className="mt-1 font-mono text-sm font-bold text-emerald-400">
            ${officeSummary.totalCostUsd.toFixed(5)} USD
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400">
            {officeSummary.callsCount} chamadas registradas
          </div>
        </div>

        <div className="border border-slate-800 bg-slate-950 p-3">
          <div className="text-[10px] uppercase text-slate-400">Custo Médio / Run</div>
          <div className="mt-1 font-mono text-sm font-bold text-amber-300">
            ${officeSummary.avgCostPerRunUsd.toFixed(5)} USD
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400">{effectiveRunsCount} runs</div>
        </div>

        <div className="border border-slate-800 bg-slate-950 p-3">
          <div className="text-[10px] uppercase text-slate-400">Custo / Short Publicado</div>
          <div className="mt-1 font-mono text-sm font-bold text-emerald-300">
            ${officeSummary.costPerPublishedShortUsd.toFixed(5)} USD
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400">
            {effectiveShortsCount} Shorts entregues
          </div>
        </div>

        <div className="border border-slate-800 bg-slate-950 p-3">
          <div className="text-[10px] uppercase text-slate-400">Latência (Média / P95)</div>
          <div className="mt-1 font-mono text-sm font-bold text-white">
            {officeSummary.avgLatencyMs}ms / {officeSummary.p95LatencyMs}ms
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400">Tempo por chamada LLM</div>
        </div>

        <div className="border border-slate-800 bg-slate-950 p-3">
          <div className="text-[10px] uppercase text-slate-400">Taxa de Erro</div>
          <div
            className={`mt-1 font-mono text-sm font-bold ${
              officeSummary.errorRatePercent > 0 ? 'text-red-400' : 'text-emerald-400'
            }`}
          >
            {officeSummary.errorRatePercent}% ({officeSummary.errorCount} erros)
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400">Retries com backoff ativos</div>
        </div>
      </div>

      {/* 3. Controle de Orcamento Mensal por Agente (Gatilho 80% Alerta e 100% Pausa na Copa) */}
      <div className="space-y-2">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">
          Orçamento Mensal &amp; Telemetria Individual por Agente (Trava Automática em 100%)
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          {agents.map((ag) => {
            const agCalls = activeCalls.filter((c) => c.agent_id === ag.id);
            const agMetrics = computeTelemetryMetricsFromCalls(agCalls);
            const budgetEval = evaluateAgentBudgetStatus(
              agMetrics.totalTokens,
              ag.monthlyTokenBudget ?? 500_000,
            );

            return (
              <div
                key={ag.id}
                className={`border-2 bg-slate-950 p-3.5 text-xs ${
                  budgetEval.status === 'exceeded_100'
                    ? 'border-red-500/90'
                    : budgetEval.status === 'warning_80'
                      ? 'border-amber-400/90'
                      : 'border-slate-800'
                }`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] font-bold uppercase text-amber-400">
                      {ag.roleName} // {ag.deskSlot}
                    </div>
                    <div className="font-bold text-white">{ag.name}</div>
                  </div>
                  {budgetEval.status === 'exceeded_100' ? (
                    <span className="border border-red-500 bg-red-950/80 px-2 py-0.5 text-[10px] font-bold uppercase text-red-200">
                      💤 Pausado (100%)
                    </span>
                  ) : budgetEval.status === 'warning_80' ? (
                    <span className="border border-amber-400 bg-amber-950/80 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-200">
                      ⚠️ Alerta ≥80%
                    </span>
                  ) : (
                    <span className="border border-emerald-500/60 bg-emerald-950/60 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
                      OK ({budgetEval.usagePercent}%)
                    </span>
                  )}
                </div>

                {/* Barra de Consumo do Orcamento */}
                <div className="mb-2">
                  <div className="mb-1 flex justify-between text-[11px] text-slate-400">
                    <span>
                      {budgetEval.tokensUsed.toLocaleString()} /{' '}
                      {(budgetEval.monthlyTokenBudget ?? 500_000).toLocaleString()} tok
                    </span>
                    <span className="font-mono font-bold text-white">
                      {budgetEval.usagePercent}%
                    </span>
                  </div>
                  <div className="h-2 w-full bg-slate-800">
                    <div
                      className={`h-full transition-all ${
                        budgetEval.status === 'exceeded_100'
                          ? 'bg-red-500'
                          : budgetEval.status === 'warning_80'
                            ? 'bg-amber-400'
                            : 'bg-emerald-500'
                      }`}
                      style={{
                        width: `${Math.min(100, Math.round(budgetEval.usagePercent))}%`,
                      }}
                    />
                  </div>
                </div>

                <div className="mb-3 grid grid-cols-3 gap-1 border border-slate-900 bg-slate-900/60 p-2 text-[10px] text-slate-300">
                  <div>
                    <div className="text-slate-500">Custo Acum.</div>
                    <div className="font-mono font-bold text-emerald-400">
                      ${agMetrics.totalCostUsd.toFixed(4)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Latência Méd.</div>
                    <div className="font-mono font-bold text-white">
                      {agMetrics.avgLatencyMs}ms
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Chamadas</div>
                    <div className="font-mono font-bold text-amber-300">
                      {agMetrics.callsCount}x
                    </div>
                  </div>
                </div>

                {/* Botoes para Simular / Testar Gatilhos de 80% e 100% */}
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={budgetSimLoadingId !== null}
                    onClick={() => handleBudgetButton(ag.id, 'hit_80')}
                    className="border border-amber-500/70 bg-amber-950/40 px-2 py-1 text-[10px] font-bold uppercase text-amber-300 hover:border-amber-400"
                  >
                    ⚠️ Simular 80%
                  </button>
                  <button
                    type="button"
                    disabled={budgetSimLoadingId !== null}
                    onClick={() => handleBudgetButton(ag.id, 'hit_100')}
                    className="border border-red-500/80 bg-red-950/50 px-2 py-1 text-[10px] font-bold uppercase text-red-200 hover:border-red-400"
                  >
                    💤 Simular 100% (Pausar)
                  </button>
                  <button
                    type="button"
                    disabled={budgetSimLoadingId !== null}
                    onClick={() => handleBudgetButton(ag.id, 'restore')}
                    className="border border-emerald-500/70 bg-emerald-950/40 px-2 py-1 text-[10px] font-bold uppercase text-emerald-300 hover:border-emerald-400"
                  >
                    ↺ Liberar
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
