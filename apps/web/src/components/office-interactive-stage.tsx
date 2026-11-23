'use client';

import {
  buildMockShortsScenarioSteps,
  EFFORT_CONFIG_MAP,
  estimateTaskCostUsd,
  EVENT_VISUAL_CATALOG,
  getDefaultNextDeskSlot,
  parseRequestedVideoCount,
  planYoutubeShortPublication,
  ROLE_TOOL_DESCRIPTIONS,
  SPRITE_CATALOG,
  YOUTUBE_DAILY_MAX_UPLOADS,
  YOUTUBE_DAILY_QUOTA_UNITS,
  YOUTUBE_SHORTS_ROLES,
  type AgentEventType,
  type DeskSlot,
  type LlmCallTelemetryRow,
  type MockScenarioAction,
  type VisualOfficeAgent,
} from '@workoffice/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArtifactPreviewModal,
  type PreviewableArtifact,
} from './artifact-preview-modal';
import { InteractiveJsonViewer } from './interactive-json-viewer';
import OfficeGameCanvas, {
  type ActiveAgentVisualState,
  type CanvasVisualCommand,
} from './office-game-canvas';
import {
  OfficeObservabilityPanel,
  type TraceTaskItem,
} from './office-observability-panel';
import {
  reconstructInitialStatesFromEvents,
  useOfficeRealtimeStore,
  type PersistedAgentEventRow,
} from '@/lib/stores/office-realtime-store';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export interface FeedEventItem {
  id: string;
  timestamp: string;
  agentId: string;
  agentName: string;
  roleName: string;
  type: AgentEventType;
  message: string;
  progress?: number;
}

export interface AgentArtifactItem {
  id: string;
  title: string;
  kind: string;
  storagePath?: string | null;
  fromOrTo: string;
  timestamp: string;
  status: 'pending' | 'processing' | 'delivered';
  metadata?: Record<string, unknown>;
}

interface AgentCostStats {
  tokens: number;
  lastTaskCostUsd: number;
  completedTasksCount: number;
  dailyCostUsd: number;
}

interface OfficeInteractiveStageProps {
  officeId?: string;
  officeName: string;
  subtitleBadge?: string;
  agents: readonly VisualOfficeAgent[];
  headerActions?: ReactNode;
}

export function OfficeInteractiveStage({
  officeId,
  officeName,
  subtitleBadge = 'Estúdio de Shorts para YouTube',
  agents,
  headerActions,
}: OfficeInteractiveStageProps) {
  const [instructionInput, setInstructionInput] = useState(
    officeId ? '' : 'Crie 10 vídeos do vídeo game novo',
  );
  const [activeInstruction, setActiveInstruction] = useState(
    officeId ? '' : 'Crie 10 vídeos do vídeo game novo',
  );

  const effectiveInstruction =
    instructionInput.trim() || activeInstruction.trim() || 'Crie 3 vídeos sobre o tema solicitado';

  const scenarioSteps = useMemo(
    () => buildMockShortsScenarioSteps(agents, effectiveInstruction),
    [agents, effectiveInstruction],
  );

  const {
    connectionStatus,
    replayHistory,
    replayCursor,
    isReplayingHistory,
    setConnectionStatus,
    setLastSyncedEventId,
    setReplayHistory,
    setReplayCursor,
    setIsReplayingHistory,
  } = useOfficeRealtimeStore();

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(agents[0]?.id ?? null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLiveDatabaseRunActive, setIsLiveDatabaseRunActive] = useState(false);
  const [activeDatabaseRunId, setActiveDatabaseRunId] = useState<string | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 2 | 4>(1);
  const [currentStepIdx, setCurrentStepIdx] = useState<number>(-1);
  const [previewArtifact, setPreviewArtifact] = useState<PreviewableArtifact | null>(null);
  const [deskModalSlot, setDeskModalSlot] = useState<DeskSlot | null>(null);
  const [shelfModalSlot, setShelfModalSlot] = useState<DeskSlot | null>(null);
  const [shelfModalTab, setShelfModalTab] = useState<'inbox' | 'outbox'>('inbox');
  const [activityDetailModalItem, setActivityDetailModalItem] = useState<
    FeedEventItem | 'all_agent_logs' | null
  >(null);

  const [activeStates, setActiveStates] = useState<Record<string, ActiveAgentVisualState>>(() => {
    const initial: Record<string, ActiveAgentVisualState> = {};
    for (const ag of agents) {
      initial[ag.id] = {
        eventType: 'agent.idle',
        message:
          ag.roleSlug === 'scriptwriter'
            ? 'Descansando na copa até receber uma instrução.'
            : 'Descansando na copa até receber input na sua estante.',
      };
    }
    return initial;
  });

  const [agentCosts, setAgentCosts] = useState<Record<string, AgentCostStats>>(() => {
    const initial: Record<string, AgentCostStats> = {};
    for (const ag of agents) {
      const est = estimateTaskCostUsd(ag.model, ag.effort);
      initial[ag.id] = {
        tokens: 0,
        lastTaskCostUsd: est,
        completedTasksCount: 1,
        dailyCostUsd: est,
      };
    }
    return initial;
  });

  const [inboxByAgent, setInboxByAgent] = useState<Record<string, AgentArtifactItem[]>>(() => {
    const init: Record<string, AgentArtifactItem[]> = {};
    for (const ag of agents) {
      init[ag.id] = [];
    }
    return init;
  });

  const [outboxByAgent, setOutboxByAgent] = useState<Record<string, AgentArtifactItem[]>>(() => {
    const init: Record<string, AgentArtifactItem[]> = {};
    for (const ag of agents) {
      init[ag.id] = [];
    }
    return init;
  });

  const [feed, setFeed] = useState<FeedEventItem[]>([]);
  const [visualCommandLog, setVisualCommandLog] = useState<CanvasVisualCommand[]>([]);
  const [syntheticCalls, setSyntheticCalls] = useState<LlmCallTelemetryRow[]>([]);
  const [syntheticTasks, setSyntheticTasks] = useState<TraceTaskItem[]>([]);
  const [pausedBudgetAgentIds, setPausedBudgetAgentIds] = useState<Record<string, boolean>>({});
  const [runsCount, setRunsCount] = useState(1);

  // 1. Hidratacao inicial a partir do banco + Assinatura Supabase Realtime quando officeId esta presente
  useEffect(() => {
    if (!officeId) return;

    let mounted = true;
    const supabase = createSupabaseBrowserClient();
    setConnectionStatus('connecting');

    async function hydrateFromDatabase() {
      const [eventsRes, llmCallsRes, artifactsRes, latestRunRes] = await Promise.all([
        supabase
          .from('agent_events')
          .select('id, office_id, agent_id, task_id, type, payload, created_at')
          .eq('office_id', officeId)
          .order('id', { ascending: false })
          .limit(60),
        supabase
          .from('llm_calls')
          .select('agent_id, input_tokens, output_tokens, reasoning_tokens, cost_usd, created_at')
          .in(
            'agent_id',
            agents.map((a) => a.id),
          )
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('artifacts')
          .select('id, kind, storage_path, metadata, created_at, runs!inner(office_id)')
          .eq('runs.office_id', officeId)
          .order('created_at', { ascending: false })
          .limit(40),
        supabase
          .from('runs')
          .select('id, input, status')
          .eq('office_id', officeId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (!mounted) return;

      const lastRunInstruction = (latestRunRes.data?.input as { instruction?: string } | null)
        ?.instruction;
      if (lastRunInstruction && lastRunInstruction.trim()) {
        setActiveInstruction(lastRunInstruction.trim());
      }

      const persistedEvents = (eventsRes.data ?? []) as unknown as PersistedAgentEventRow[];
      if (persistedEvents.length > 0) {
        const reconstructed = reconstructInitialStatesFromEvents(agents, persistedEvents);
        setActiveStates(reconstructed);
        setLastSyncedEventId(persistedEvents[0]?.id ?? 0);
        setReplayHistory([...persistedEvents].sort((a, b) => a.id - b.id));

        const initialFeed: FeedEventItem[] = persistedEvents.map((ev) => {
          const ag = agents.find((a) => a.id === ev.agent_id);
          return {
            id: `db_${ev.id}`,
            timestamp: new Date(ev.created_at).toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }),
            agentId: ev.agent_id,
            agentName: ag?.name ?? 'Agente',
            roleName: ag?.roleName ?? 'Cargo',
            type: ev.type,
            message: ev.payload?.message ?? ev.type,
            progress: ev.payload?.progress,
          };
        });
        setFeed(initialFeed);
      }

      if (llmCallsRes.data && llmCallsRes.data.length > 0) {
        setAgentCosts((prev) => {
          const next = { ...prev };
          for (const ag of agents) {
            const agCalls = llmCallsRes.data.filter((c) => c.agent_id === ag.id);
            if (agCalls.length === 0) continue;
            const totalTok = agCalls.reduce(
              (s, c) =>
                s +
                Number(c.input_tokens ?? 0) +
                Number(c.output_tokens ?? 0) +
                Number(c.reasoning_tokens ?? 0),
              0,
            );
            const totalCost = agCalls.reduce((s, c) => s + Number(c.cost_usd ?? 0), 0);
            const latestCost = Number(agCalls[0]?.cost_usd ?? 0);
            next[ag.id] = {
              tokens: totalTok,
              lastTaskCostUsd: latestCost,
              completedTasksCount: agCalls.length,
              dailyCostUsd: Number(totalCost.toFixed(5)),
            };
          }
          return next;
        });
      }

      if (artifactsRes.data && artifactsRes.data.length > 0) {
        const nextOutbox: Record<string, AgentArtifactItem[]> = {};
        const nextInbox: Record<string, AgentArtifactItem[]> = {};
        for (const ag of agents) {
          nextOutbox[ag.id] = [];
          nextInbox[ag.id] = [];
        }

        for (const row of artifactsRes.data) {
          const meta = (row.metadata ?? {}) as {
            title?: string;
            agent_id?: string;
            role_slug?: string;
            video_index?: number;
          };
          const producerId = meta.agent_id;
          const timeStr = new Date(row.created_at as string).toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          const itemTitle = meta.title ?? `${row.kind}_${String(row.id).slice(0, 6)}.json`;

          if (producerId && nextOutbox[producerId]) {
            nextOutbox[producerId]!.push({
              id: String(row.id),
              title: itemTitle,
              kind: String(row.kind),
              storagePath: (row.storage_path as string | null) ?? null,
              fromOrTo: 'Persistido no Storage/DB',
              timestamp: timeStr,
              status: 'delivered',
              metadata: meta as Record<string, unknown>,
            });
          }

          // Popula tambem a estante (Inbox) do destinatario seguinte
          if (meta.role_slug === 'scriptwriter') {
            const editor = agents.find((a) => a.roleSlug === 'video_editor');
            if (editor && nextInbox[editor.id]) {
              nextInbox[editor.id]!.push({
                id: `in_${row.id}`,
                title: itemTitle,
                kind: String(row.kind),
                storagePath: (row.storage_path as string | null) ?? null,
                fromOrTo: 'Na estante (do Roteirista)',
                timestamp: timeStr,
                status: 'pending',
                metadata: meta as Record<string, unknown>,
              });
            }
          } else if (meta.role_slug === 'video_editor') {
            const publisher = agents.find((a) => a.roleSlug === 'publisher_analyst');
            if (publisher && nextInbox[publisher.id]) {
              nextInbox[publisher.id]!.push({
                id: `in_${row.id}`,
                title: itemTitle,
                kind: String(row.kind),
                storagePath: (row.storage_path as string | null) ?? null,
                fromOrTo: 'Na estante (do Editor)',
                timestamp: timeStr,
                status: 'pending',
                metadata: meta as Record<string, unknown>,
              });
            }
          }
        }

        setOutboxByAgent(nextOutbox);
        setInboxByAgent(nextInbox);
      }
    }

    void hydrateFromDatabase();

    // Assinatura Realtime em public.agent_events filtrada por office_id
    const channel = supabase
      .channel(`office-realtime-${officeId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_events',
          filter: `office_id=eq.${officeId}`,
        },
        (payload) => {
          if (!mounted) return;
          const ev = payload.new as PersistedAgentEventRow;
          const ag = agents.find((a) => a.id === ev.agent_id);
          if (!ag) return;

          setLastSyncedEventId(ev.id);
          const nextVisualState: ActiveAgentVisualState = {
            eventType: ev.type,
            message: ev.payload?.message ?? ev.type,
            progress: ev.payload?.progress,
            targetDeskSlot: ev.payload?.targetDeskSlot,
            videoNumber: ev.payload?.videoNumber,
            totalVideos: ev.payload?.totalVideos,
          };
          setActiveStates((prev) => ({
            ...prev,
            [ev.agent_id]: nextVisualState,
          }));
          setVisualCommandLog((prev) => [
            ...prev.slice(-199),
            {
              commandId: `rt_${ev.id}`,
              agentId: ev.agent_id,
              ...nextVisualState,
            },
          ]);

          const timeStr = new Date(ev.created_at || Date.now()).toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });

          setFeed((prev) => [
            {
              id: `rt_${ev.id}_${Math.random()}`,
              timestamp: timeStr,
              agentId: ag.id,
              agentName: ag.name,
              roleName: ag.roleName,
              type: ev.type,
              message: ev.payload?.message ?? ev.type,
              progress: ev.payload?.progress,
            },
            ...prev.slice(0, 59),
          ]);
        },
      )
      .subscribe((status) => {
        if (!mounted) return;
        if (status === 'SUBSCRIBED') {
          setConnectionStatus('SUBSCRIBED');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setConnectionStatus('error');
        }
      });

    return () => {
      mounted = false;
      void supabase.removeChannel(channel);
    };
  }, [officeId, agents, setConnectionStatus, setLastSyncedEventId, setReplayHistory]);

  // 2. Stepper / Polling automatico quando uma Run real no banco esta ativa em /app/offices/[id]
  useEffect(() => {
    if (!isLiveDatabaseRunActive || !officeId) return;

    const supabase = createSupabaseBrowserClient();
    const intervalMs = Math.max(950, Math.round(2800 / playbackSpeed));
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/runs/step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            officeId,
            runId: activeDatabaseRunId,
          }),
        });
        const data = await res.json();

        // Sincroniza artifacts (Caixa de Entrada/Saida) e llm_calls produzidos pelo Worker real no banco
        const [llmCallsRes, artifactsRes] = await Promise.all([
          supabase
            .from('llm_calls')
            .select('agent_id, input_tokens, output_tokens, reasoning_tokens, cost_usd, created_at')
            .in(
              'agent_id',
              agents.map((a) => a.id),
            )
            .order('created_at', { ascending: false })
            .limit(100),
          supabase
            .from('artifacts')
            .select('id, kind, storage_path, metadata, created_at, runs!inner(office_id)')
            .eq('runs.office_id', officeId)
            .order('created_at', { ascending: false })
            .limit(40),
        ]);

        if (llmCallsRes.data && llmCallsRes.data.length > 0) {
          setAgentCosts((prev) => {
            const next = { ...prev };
            for (const ag of agents) {
              const agCalls = llmCallsRes.data.filter((c) => c.agent_id === ag.id);
              if (agCalls.length === 0) continue;
              const totalTok = agCalls.reduce(
                (s, c) =>
                  s +
                  Number(c.input_tokens ?? 0) +
                  Number(c.output_tokens ?? 0) +
                  Number(c.reasoning_tokens ?? 0),
                0,
              );
              const totalCost = agCalls.reduce((s, c) => s + Number(c.cost_usd ?? 0), 0);
              const latestCost = Number(agCalls[0]?.cost_usd ?? 0);
              next[ag.id] = {
                tokens: totalTok,
                lastTaskCostUsd: latestCost,
                completedTasksCount: agCalls.length,
                dailyCostUsd: Number(totalCost.toFixed(5)),
              };
            }
            return next;
          });
        }

        if (artifactsRes.data && artifactsRes.data.length > 0) {
          const nextOutbox: Record<string, AgentArtifactItem[]> = {};
          const nextInbox: Record<string, AgentArtifactItem[]> = {};
          for (const ag of agents) {
            nextOutbox[ag.id] = [];
            nextInbox[ag.id] = [];
          }

          for (const row of artifactsRes.data) {
            const meta = (row.metadata ?? {}) as {
              title?: string;
              agent_id?: string;
              role_slug?: string;
              video_index?: number;
              output?: {
                published_videos?: {
                  url?: string;
                  output_summary?: string;
                }[];
              };
            };
            const timeStr = new Date(row.created_at as string).toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            });
            const inferredRole: string =
              meta.role_slug ??
              (row.kind === 'research_brief'
                ? 'scriptwriter'
                : row.kind === 'edited_short'
                  ? 'video_editor'
                  : 'publisher_analyst');
            const producer =
              agents.find((a) => a.id === meta.agent_id) ??
              agents.find((a) => a.roleSlug === inferredRole);
            const itemTitle = meta.title ?? `${row.kind}_${String(row.id).slice(0, 6)}.json`;
            const pubVideo = meta.output?.published_videos?.[0];

            if (producer && nextOutbox[producer.id]) {
              nextOutbox[producer.id]!.push({
                id: String(row.id),
                title: itemTitle,
                kind: String(row.kind),
                storagePath: (row.storage_path as string | null) ?? null,
                fromOrTo:
                  pubVideo?.output_summary ??
                  (pubVideo?.url ? `URL Publicada: ${pubVideo.url}` : 'Persistido no Storage/DB'),
                timestamp: timeStr,
                status: 'delivered',
                metadata: meta as Record<string, unknown>,
              });
            }

            if (inferredRole === 'scriptwriter') {
              const editor = agents.find((a) => a.roleSlug === 'video_editor');
              if (editor && nextInbox[editor.id]) {
                nextInbox[editor.id]!.push({
                  id: `in_${row.id}`,
                  title: itemTitle,
                  kind: String(row.kind),
                  storagePath: (row.storage_path as string | null) ?? null,
                  fromOrTo: 'Na estante (do Roteirista)',
                  timestamp: timeStr,
                  status: 'pending',
                  metadata: meta as Record<string, unknown>,
                });
              }
            } else if (inferredRole === 'video_editor') {
              const publisher = agents.find((a) => a.roleSlug === 'publisher_analyst');
              if (publisher && nextInbox[publisher.id]) {
                nextInbox[publisher.id]!.push({
                  id: `in_${row.id}`,
                  title: itemTitle,
                  kind: String(row.kind),
                  storagePath: (row.storage_path as string | null) ?? null,
                  fromOrTo: 'Na estante (do Editor)',
                  timestamp: timeStr,
                  status: 'pending',
                  metadata: meta as Record<string, unknown>,
                });
              }
            }
          }

          setOutboxByAgent(nextOutbox);
          setInboxByAgent(nextInbox);
        }

        if (!res.ok || !data.stepResult?.has_more) {
          setIsLiveDatabaseRunActive(false);
        }
      } catch {
        setIsLiveDatabaseRunActive(false);
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isLiveDatabaseRunActive, officeId, activeDatabaseRunId, playbackSpeed, agents]);

  // 3. Player de Replay Historico a partir dos eventos persistidos no banco
  useEffect(() => {
    if (!isReplayingHistory || replayHistory.length === 0) return;

    const nextIdx = replayCursor + 1;
    if (nextIdx >= replayHistory.length) {
      setIsReplayingHistory(false);
      return;
    }

    const delay = Math.max(450, Math.round(1600 / playbackSpeed));
    const timer = setTimeout(() => {
      const ev = replayHistory[nextIdx];
      if (ev) {
        setReplayCursor(nextIdx);
        const replayVisualState: ActiveAgentVisualState = {
          eventType: ev.type,
          message: `[REPLAY] ${ev.payload?.message ?? ev.type}`,
          progress: ev.payload?.progress,
          targetDeskSlot: ev.payload?.targetDeskSlot,
          videoNumber: ev.payload?.videoNumber,
          totalVideos: ev.payload?.totalVideos,
        };
        setActiveStates((prev) => ({
          ...prev,
          [ev.agent_id]: replayVisualState,
        }));
        setVisualCommandLog((prev) => [
          ...prev.slice(-199),
          {
            commandId: `replay_${ev.id}_${nextIdx}`,
            agentId: ev.agent_id,
            ...replayVisualState,
          },
        ]);
      }
    }, delay);

    return () => clearTimeout(timer);
  }, [
    isReplayingHistory,
    replayCursor,
    replayHistory,
    playbackSpeed,
    setIsReplayingHistory,
    setReplayCursor,
  ]);

  function dispatchVisualAction(action: MockScenarioAction) {
    const ag = agents.find((a) => a.id === action.agentId);
    if (!ag) return;

    // Se o agente atingiu 100% do orcamento (paused_budget), bloqueia novas tasks e mantem na copa com 💤
    if (pausedBudgetAgentIds[action.agentId] && action.type !== 'budget.exceeded') {
      return;
    }

    const actionVisualState: ActiveAgentVisualState = {
      eventType: action.type,
      message: action.message,
      progress: action.progress,
      targetDeskSlot: action.targetDeskSlot,
      videoNumber: action.videoNumber,
      totalVideos: action.totalVideos,
    };

    setActiveStates((prev) => ({
      ...prev,
      [action.agentId]: actionVisualState,
    }));
    setVisualCommandLog((prev) => [
      ...prev.slice(-199),
      {
        commandId: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        agentId: action.agentId,
        ...actionVisualState,
      },
    ]);

    const now = new Date().toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    if (
      action.tokensUsedDelta > 0 ||
      action.costUsdDelta > 0 ||
      action.type === 'handoff.sent' ||
      action.type === 'task.completed'
    ) {
      const taskId = `task_${action.agentId.slice(0, 6)}_v${action.videoNumber ?? 1}`;
      if (action.tokensUsedDelta > 0 || action.costUsdDelta > 0) {
        const inTok = Math.round(action.tokensUsedDelta * 0.6);
        const outTok = action.tokensUsedDelta - inTok;
        const reasonTok = ag.effort === 'high' ? 1024 : ag.effort === 'medium' ? 256 : 0;

        setSyntheticCalls((prev) => [
          {
            id: `call_${Date.now()}_${Math.random()}`,
            task_id: taskId,
            agent_id: ag.id,
            provider: ag.provider,
            model: ag.model,
            effort: ag.effort,
            input_tokens: inTok,
            output_tokens: outTok,
            reasoning_tokens: reasonTok,
            cost_usd: action.costUsdDelta,
            latency_ms: 680 + (action.videoNumber ?? 1) * 45,
            error: null,
            created_at: new Date().toISOString(),
          },
          ...prev.slice(0, 79),
        ]);

        setSyntheticTasks((prev) => {
          const exists = prev.some((t) => t.id === taskId);
          const item: TraceTaskItem = {
            id: taskId,
            agent_id: ag.id,
            agent_name: ag.name,
            role_name: ag.roleName,
            role_slug: ag.roleSlug,
            status: 'completed',
            attempts: 1,
            input: {
              instruction: activeInstruction,
              video_index: action.videoNumber ?? 1,
              total_videos: action.totalVideos ?? 10,
            },
            output: {
              artifact: action.artifactTitle ?? action.message,
              progress: action.progress ?? 100,
            },
            created_at: new Date().toISOString(),
          };
          return exists ? prev.map((t) => (t.id === taskId ? item : t)) : [item, ...prev];
        });
      }

      setAgentCosts((prev) => {
        const cur = prev[action.agentId] ?? {
          tokens: 0,
          lastTaskCostUsd: 0,
          completedTasksCount: 0,
          dailyCostUsd: 0,
        };
        const finishedUnit =
          action.type === 'handoff.sent' || action.type === 'task.completed';
        const nextDaily = Number((cur.dailyCostUsd + action.costUsdDelta).toFixed(5));
        const nextLast =
          action.costUsdDelta > 0
            ? Number(action.costUsdDelta.toFixed(5))
            : cur.lastTaskCostUsd;
        return {
          ...prev,
          [action.agentId]: {
            tokens: cur.tokens + action.tokensUsedDelta,
            lastTaskCostUsd: nextLast,
            completedTasksCount: finishedUnit
              ? cur.completedTasksCount + 1
              : Math.max(1, cur.completedTasksCount),
            dailyCostUsd: nextDaily,
          },
        };
      });
    }

    const vNum = action.videoNumber ?? 1;
    const vPad = String(vNum).padStart(2, '0');

    if (action.type === 'task.started' && ag.roleSlug === 'scriptwriter') {
      setInboxByAgent((prev) => ({
        ...prev,
        [ag.id]: [
          {
            id: `in_sw_${Date.now()}`,
            title: `Instrução: "${activeInstruction}"`,
            kind: 'instruction',
            fromOrTo: 'De: Usuário',
            timestamp: now,
            status: 'processing',
            metadata: { instruction: activeInstruction, video_index: vNum },
          },
        ],
      }));
    }

    if (action.type === 'handoff.sent' && ag.roleSlug === 'scriptwriter') {
      const editor = agents.find((a) => a.roleSlug === 'video_editor');
      const artifactTitle =
        action.artifactTitle ??
        `instrucao_edicao_video_${vPad}.json`;

      const metadata = {
        video_index: vNum,
        total_videos: action.totalVideos ?? 10,
        instruction: activeInstruction,
        source_url: `https://www.youtube.com/watch?v=source_${vPad}`,
        start_sec: 60 + vNum * 15,
        end_sec: 112 + vNum * 15,
        hook: `Gancho de abertura para o Vídeo #${vNum}: ${activeInstruction}`,
      };

      setOutboxByAgent((prev) => ({
        ...prev,
        [ag.id]: [
          {
            id: `out_sw_${vNum}_${Date.now()}`,
            title: artifactTitle,
            kind: 'research_brief',
            fromOrTo: `Estante de ${editor?.name ?? 'Editor'}`,
            timestamp: now,
            status: 'delivered',
            metadata,
          },
          ...(prev[ag.id] ?? []),
        ],
      }));

      if (editor) {
        setInboxByAgent((prev) => ({
          ...prev,
          [editor.id]: [
            {
              id: `in_ed_${vNum}_${Date.now()}`,
              title: artifactTitle,
              kind: 'research_brief',
              fromOrTo: `Na estante (de ${ag.name})`,
              timestamp: now,
              status: 'pending',
              metadata,
            },
            ...(prev[editor.id] ?? []),
          ],
        }));
      }
    }

    if (action.type === 'handoff.sent' && ag.roleSlug === 'video_editor') {
      const publisher = agents.find((a) => a.roleSlug === 'publisher_analyst');
      const artifactTitle =
        action.artifactTitle ?? `video_short_${vPad}_9x16.mp4`;
      const storagePath = `${officeId ?? 'demo'}/run/short_${vPad}_9x16.mp4`;
      const metadata = {
        video_index: vNum,
        resolution: '1080x1920',
        duration_sec: 52,
        storage_path: storagePath,
        subtitle_path: `${officeId ?? 'demo'}/run/short_${vPad}.srt`,
      };

      setOutboxByAgent((prev) => ({
        ...prev,
        [ag.id]: [
          {
            id: `out_ed_${vNum}_${Date.now()}`,
            title: artifactTitle,
            kind: 'edited_short',
            storagePath,
            fromOrTo: `Estante de ${publisher?.name ?? 'Publicador'}`,
            timestamp: now,
            status: 'delivered',
            metadata,
          },
          ...(prev[ag.id] ?? []),
        ],
      }));

      if (publisher) {
        setInboxByAgent((prev) => ({
          ...prev,
          [publisher.id]: [
            {
              id: `in_pub_${vNum}_${Date.now()}`,
              title: artifactTitle,
              kind: 'edited_short',
              storagePath,
              fromOrTo: `Na estante (de ${ag.name})`,
              timestamp: now,
              status: 'pending',
              metadata,
            },
            ...(prev[publisher.id] ?? []),
          ],
        }));
      }
    }

    if (
      (action.type === 'metrics.check' || action.type === 'task.completed') &&
      ag.roleSlug === 'publisher_analyst'
    ) {
      const pubPlan = planYoutubeShortPublication({
        videoIndex: vNum,
        videoId: `yt_short_${vPad}`,
      });
      const artifactTitle =
        action.artifactTitle ??
        (pubPlan.isWithinDailyQuota
          ? `short_${vPad}_publicado_url.json`
          : `short_${vPad}_agendamento.json`);

      const metadata = pubPlan.isWithinDailyQuota
        ? {
            video_index: vNum,
            publication_status: 'published',
            short_url: pubPlan.shortUrl,
            youtube_video_id: pubPlan.youtubeVideoId,
            daily_quota_used_videos: `${pubPlan.dailyQuotaUsedVideos}/${YOUTUBE_DAILY_MAX_UPLOADS}`,
            daily_quota_units: `${pubPlan.dailyQuotaUsedVideos * pubPlan.quotaUnitsConsumed}/${YOUTUBE_DAILY_QUOTA_UNITS}`,
            periodicity_interval_hours: pubPlan.intervalHours,
            output_summary: pubPlan.outputSummary,
            views: 1350 + vNum * 290,
            retention_pct: 91.8,
          }
        : {
            video_index: vNum,
            publication_status: 'scheduled',
            reserved_short_url: pubPlan.shortUrl,
            youtube_video_id: pubPlan.youtubeVideoId,
            schedule_details: pubPlan.scheduleDetails,
            output_summary: pubPlan.outputSummary,
          };

      setOutboxByAgent((prev) => ({
        ...prev,
        [ag.id]: [
          {
            id: `out_pub_${vNum}_${Date.now()}`,
            title: artifactTitle,
            kind: 'publish_report',
            fromOrTo: pubPlan.isWithinDailyQuota
              ? `URL Publicada: ${pubPlan.shortUrl}`
              : `Agendado: ${pubPlan.scheduledForFormatted} (Dia +${pubPlan.dayOffset} • Slot ${pubPlan.slotInDay}/${YOUTUBE_DAILY_MAX_UPLOADS})`,
            timestamp: now,
            status: 'delivered',
            metadata,
          },
          ...(prev[ag.id] ?? []),
        ],
      }));
    }

    setFeed((prev) => [
      {
        id: `${Date.now()}_${Math.random()}`,
        timestamp: now,
        agentId: ag.id,
        agentName: ag.name,
        roleName: ag.roleName,
        type: action.type,
        message: action.message,
        progress: action.progress,
      },
      ...prev.slice(0, 59),
    ]);
  }

  function advanceScenarioStep(targetIndex: number) {
    const step = scenarioSteps[targetIndex];
    if (!step) {
      setIsPlaying(false);
      return;
    }

    setCurrentStepIdx(targetIndex);
    dispatchVisualAction(step);
    if (step.concurrentActions && step.concurrentActions.length > 0) {
      for (const concurrent of step.concurrentActions) {
        dispatchVisualAction(concurrent);
      }
    }
  }

  useEffect(() => {
    if (!isPlaying) return;

    const nextIdx = currentStepIdx + 1;
    if (nextIdx >= scenarioSteps.length) {
      setIsPlaying(false);
      return;
    }

    const baseDuration = (scenarioSteps[currentStepIdx]?.durationMs ?? 2600) + 1200;
    const delay = Math.max(900, Math.round(baseDuration / playbackSpeed));

    const timer = setTimeout(() => {
      advanceScenarioStep(nextIdx);
    }, delay);

    return () => clearTimeout(timer);
  }, [isPlaying, currentStepIdx, playbackSpeed, scenarioSteps]);

  function handleResetSimulation() {
    setIsPlaying(false);
    setIsLiveDatabaseRunActive(false);
    setIsReplayingHistory(false);
    setCurrentStepIdx(-1);
    const resetStates: Record<string, ActiveAgentVisualState> = {};
    const emptyBoxes: Record<string, AgentArtifactItem[]> = {};
    for (const ag of agents) {
      resetStates[ag.id] = {
        eventType: 'agent.idle',
        message:
          ag.roleSlug === 'scriptwriter'
            ? 'Descansando na copa até receber uma instrução.'
            : 'Descansando na copa até receber input na sua estante.',
      };
      emptyBoxes[ag.id] = [];
    }
    setActiveStates(resetStates);
    setVisualCommandLog([]);
    setInboxByAgent(emptyBoxes);
    setOutboxByAgent(emptyBoxes);
    setFeed([]);
  }

  async function handleSendAgentToRest(agentId: string) {
    const ag = agents.find((a) => a.id === agentId);
    if (!ag) return;
    setIsPlaying(false);
    setIsLiveDatabaseRunActive(false);

    if (officeId) {
      await fetch('/api/runs/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          officeId,
          runId: activeDatabaseRunId,
          agentId,
        }),
      }).catch(() => {});
    }

    dispatchVisualAction({
      agentId: ag.id,
      agentName: ag.name,
      roleSlug: ag.roleSlug,
      type: 'agent.idle',
      message: `Atividade interrompida pelo usuário! ${ag.name} foi mandado descansar na copa.`,
      tokensUsedDelta: 0,
      costUsdDelta: 0,
    });
  }

  async function handleSendAllAgentsToRest() {
    setIsPlaying(false);
    setIsLiveDatabaseRunActive(false);

    if (officeId) {
      await fetch('/api/runs/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          officeId,
          runId: activeDatabaseRunId,
        }),
      }).catch(() => {});
    }

    for (const ag of agents) {
      dispatchVisualAction({
        agentId: ag.id,
        agentName: ag.name,
        roleSlug: ag.roleSlug,
        type: 'agent.idle',
        message: `Atividades interrompidas! ${ag.name} foi mandado descansar na copa.`,
        tokensUsedDelta: 0,
        costUsdDelta: 0,
      });
    }
  }

  async function handleDispatchInstructionToScriptwriter() {
    const clean =
      instructionInput.trim() ||
      activeInstruction.trim() ||
      'Crie 3 vídeos sobre o tema solicitado';
    setActiveInstruction(clean);
    setInstructionInput(clean);
    setRunsCount((prev) => prev + 1);
    setCurrentStepIdx(-1);

    const initialStates: Record<string, ActiveAgentVisualState> = {};
    const emptyBoxes: Record<string, AgentArtifactItem[]> = {};
    for (const ag of agents) {
      initialStates[ag.id] = {
        eventType: 'agent.idle',
        message:
          ag.roleSlug === 'scriptwriter'
            ? `Recebendo instrução: "${clean}"`
            : 'Descansando na copa até chegar o 1º vídeo na sua estante.',
      };
      emptyBoxes[ag.id] = [];
    }
    setActiveStates(initialStates);
    setVisualCommandLog([]);
    setInboxByAgent(emptyBoxes);
    setOutboxByAgent(emptyBoxes);

    // Se estamos dentro de um escritorio real no banco (officeId), dispara a Run real no Postgres/pgmq para o Worker da Railway processar!
    if (officeId) {
      try {
        const res = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            officeId,
            instruction: clean,
            clipCount: parseRequestedVideoCount(clean),
          }),
        });
        const data = await res.json();
        if (res.ok && data.run?.run_id) {
          setActiveDatabaseRunId(String(data.run.run_id));
          setIsLiveDatabaseRunActive(true);
          return;
        }
      } catch {
        // Fallback para simulacao local apenas se a API falhar
      }
    }

    setTimeout(() => {
      const freshSteps = buildMockShortsScenarioSteps(agents, clean);
      const first = freshSteps[0];
      if (first) {
        setCurrentStepIdx(0);
        dispatchVisualAction(first);
        if (first.concurrentActions) {
          for (const c of first.concurrentActions) {
            dispatchVisualAction(c);
          }
        }
      }
      setIsPlaying(true);
    }, 60);
  }

  function handleStartReplayHistory() {
    if (replayHistory.length === 0) return;
    setIsPlaying(false);
    setIsLiveDatabaseRunActive(false);
    setVisualCommandLog([]);
    setReplayCursor(-1);
    setIsReplayingHistory(true);
  }

  function handleTriggerBudgetAction(
    agentId: string,
    action: 'hit_80' | 'hit_100' | 'restore',
  ) {
    const ag = agents.find((a) => a.id === agentId);
    if (!ag) return;
    const budget = ag.monthlyTokenBudget ?? 500_000;

    if (action === 'restore') {
      setPausedBudgetAgentIds((prev) => ({ ...prev, [agentId]: false }));
      setSyntheticCalls((prev) => prev.filter((c) => c.agent_id !== agentId));
      const restoredState: ActiveAgentVisualState = {
        eventType: 'agent.idle',
        message: `Orçamento de ${ag.name} restaurado! Pronto para novas tarefas.`,
      };
      setActiveStates((prev) => ({
        ...prev,
        [agentId]: restoredState,
      }));
      setVisualCommandLog((prev) => [
        ...prev.slice(-199),
        {
          commandId: `budget_restore_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          agentId,
          ...restoredState,
        },
      ]);
      return;
    }

    const targetTokens = action === 'hit_80' ? Math.round(budget * 0.85) : budget + 5000;
    const taskId = `task_budget_${action}_${Date.now()}`;

    setSyntheticCalls((prev) => [
      {
        id: `call_budget_${Date.now()}`,
        task_id: taskId,
        agent_id: ag.id,
        provider: ag.provider,
        model: ag.model,
        effort: ag.effort,
        input_tokens: Math.round(targetTokens * 0.6),
        output_tokens: Math.round(targetTokens * 0.4),
        reasoning_tokens: 0,
        cost_usd: Number(((targetTokens / 1_000_000) * 4.2).toFixed(5)),
        latency_ms: 790,
        error: null,
        created_at: new Date().toISOString(),
      },
      ...prev.filter((c) => c.agent_id !== agentId),
    ]);

    if (action === 'hit_100') {
      setPausedBudgetAgentIds((prev) => ({ ...prev, [agentId]: true }));
      const exceededState: ActiveAgentVisualState = {
        eventType: 'budget.exceeded',
        message: `100% do orçamento mensal atingido (${budget.toLocaleString()} tok)! ${ag.name} teve novas tasks bloqueadas e foi pausado na copa (💤).`,
      };
      setActiveStates((prev) => ({
        ...prev,
        [agentId]: exceededState,
      }));
      setVisualCommandLog((prev) => [
        ...prev.slice(-199),
        {
          commandId: `budget_100_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          agentId,
          ...exceededState,
        },
      ]);
      setFeed((prev) => [
        {
          id: `budget_${Date.now()}`,
          timestamp: new Date().toLocaleTimeString('pt-BR'),
          agentId: ag.id,
          agentName: ag.name,
          roleName: ag.roleName,
          type: 'budget.exceeded',
          message: `ALERTA 100%: ${ag.name} atingiu o teto de tokens e foi movido para a copa com ícone de pausa (💤).`,
        },
        ...prev,
      ]);
    }
  }

  const workingCount = Object.values(activeStates).filter(
    (s) => s.eventType !== 'agent.idle' && s.eventType !== 'budget.exceeded',
  ).length;
  const restingCount = agents.length - workingCount;
  const officeDailyCostUsd = Object.values(agentCosts).reduce(
    (sum, item) => sum + item.dailyCostUsd,
    0,
  );
  const officeTotalTokens = Object.values(agentCosts).reduce((sum, item) => sum + item.tokens, 0);
  const officeArtifactsCount = Object.values(outboxByAgent).reduce(
    (sum, list) => sum + list.length,
    0,
  );

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? agents[0] ?? null;
  const selectedSpriteInfo =
    SPRITE_CATALOG.find((s) => s.key === selectedAgent?.spriteKey) ?? SPRITE_CATALOG[0]!;
  const selectedVisualState = selectedAgent ? activeStates[selectedAgent.id] : undefined;
  const selectedMapping = selectedVisualState
    ? EVENT_VISUAL_CATALOG[selectedVisualState.eventType]
    : EVENT_VISUAL_CATALOG['agent.idle'];
  const selectedCostStats = selectedAgent
    ? (agentCosts[selectedAgent.id] ?? {
        tokens: 0,
        lastTaskCostUsd: 0,
        completedTasksCount: 1,
        dailyCostUsd: 0,
      })
    : { tokens: 0, lastTaskCostUsd: 0, completedTasksCount: 1, dailyCostUsd: 0 };

  const selectedAvgTaskCostUsd =
    selectedCostStats.dailyCostUsd / Math.max(1, selectedCostStats.completedTasksCount);
  const selectedInbox = selectedAgent ? (inboxByAgent[selectedAgent.id] ?? []) : [];
  const selectedOutbox = selectedAgent ? (outboxByAgent[selectedAgent.id] ?? []) : [];
  const selectedLogs = selectedAgent
    ? feed.filter((item) => item.agentId === selectedAgent.id)
    : [];
  const nextDeskForSelected: DeskSlot = selectedAgent
    ? getDefaultNextDeskSlot(selectedAgent.deskSlot)
    : 'desk_2';

  const deskModalAgent = deskModalSlot
    ? (agents.find((a) => a.deskSlot === deskModalSlot) ?? selectedAgent)
    : null;
  const deskModalRoleDef = deskModalAgent
    ? (YOUTUBE_SHORTS_ROLES.find((r) => r.slug === deskModalAgent.roleSlug) ??
      YOUTUBE_SHORTS_ROLES[0]!)
    : null;
  const deskModalEffortCfg = deskModalAgent ? EFFORT_CONFIG_MAP[deskModalAgent.effort] : null;

  const shelfModalAgent = shelfModalSlot
    ? (agents.find((a) => a.deskSlot === shelfModalSlot) ?? selectedAgent)
    : null;
  const shelfModalInbox = shelfModalAgent ? (inboxByAgent[shelfModalAgent.id] ?? []) : [];
  const shelfModalOutbox = shelfModalAgent ? (outboxByAgent[shelfModalAgent.id] ?? []) : [];

  return (
    <section className="space-y-4">
      <ArtifactPreviewModal
        artifact={previewArtifact}
        onClose={() => setPreviewArtifact(null)}
      />

      {/* MODAL 1: Detalhes da Mesa / Computador CRT (Ferramentas do Agente e Instrucoes de Contexto) */}
      {deskModalSlot && deskModalAgent && deskModalRoleDef && deskModalEffortCfg && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto border-2 border-emerald-500 bg-slate-900 p-6 shadow-[8px_8px_0px_0px_rgba(16,185,129,0.28)]">
            <div className="mb-4 flex items-start justify-between border-b border-slate-800 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">
                  💻 Estação de Trabalho // {deskModalAgent.deskSlot.toUpperCase()} (
                  {deskModalRoleDef.workstationType})
                </span>
                <h3 className="text-lg font-bold text-white">
                  {deskModalAgent.name} — {deskModalAgent.roleName}
                </h3>
                <p className="text-xs text-slate-400">
                  Provedor: <strong className="text-emerald-300">{deskModalAgent.provider.toUpperCase()}</strong> •
                  Modelo: <strong className="text-white">{deskModalAgent.model}</strong> • Esforço:{' '}
                  <strong className="uppercase text-amber-300">{deskModalAgent.effort}</strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDeskModalSlot(null)}
                className="border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
              >
                ✕ Fechar
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Ferramentas Permitidas do Agente */}
              <div className="border border-slate-800 bg-slate-950 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-bold uppercase tracking-wider text-amber-300">
                    🛠️ Ferramentas Autorizadas do Agente (`allowed_tools`)
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    {deskModalRoleDef.allowedTools.length} tools habilitadas no Tool Registry
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {deskModalRoleDef.allowedTools.map((toolName) => {
                    const toolInfo = ROLE_TOOL_DESCRIPTIONS[toolName];
                    return (
                      <div
                        key={toolName}
                        className="border border-slate-800 bg-slate-900/80 p-2.5"
                      >
                        <div className="flex items-center justify-between">
                          <code className="font-bold text-emerald-300">{toolName}()</code>
                          {toolInfo?.eventType && (
                            <span className="border border-amber-500/40 bg-amber-950/40 px-1.5 py-0.5 font-mono text-[9px] text-amber-300">
                              {toolInfo.eventType}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
                          {toolInfo?.description ?? 'Ferramenta operacional do cargo.'}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Instrucoes de Contexto (System Prompt + Escopo + Instrucao Ativa) */}
              <div className="border border-slate-800 bg-slate-950 p-4">
                <div className="mb-2 font-bold uppercase tracking-wider text-emerald-300">
                  🧠 Instruções de Contexto (`system_prompt` &amp; Escopo Operacional)
                </div>
                <div className="mb-3 space-y-1.5 text-slate-300">
                  <div>
                    <span className="font-bold text-slate-400">Escopo do Cargo: </span>
                    <span>{deskModalRoleDef.scope}</span>
                  </div>
                  <div>
                    <span className="font-bold text-slate-400">Instrução Ativa no Escritório: </span>
                    <span className="font-mono text-amber-300">&ldquo;{activeInstruction}&rdquo;</span>
                  </div>
                </div>
                <div className="mb-1 text-[10px] font-bold uppercase text-slate-400">
                  System Prompt Injetado no LLM:
                </div>
                <pre className="whitespace-pre-wrap border border-slate-800 bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-emerald-200">
                  {deskModalRoleDef.systemPrompt}
                </pre>
              </div>

              {/* Contratos de Input/Output e Tetos Operacionais de Esforco */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="border border-slate-800 bg-slate-950 p-3.5">
                  <div className="mb-1.5 font-bold uppercase text-amber-300">
                    📋 Contrato de Entrada e Saída
                  </div>
                  <div className="space-y-1.5 text-[11px] text-slate-300">
                    <div>
                      <strong className="text-slate-400">Input Esperado:</strong>{' '}
                      {deskModalRoleDef.inputContractSummary}
                    </div>
                    <div>
                      <strong className="text-slate-400">Output Entregue:</strong>{' '}
                      {deskModalRoleDef.outputContractSummary}
                    </div>
                  </div>
                </div>

                <div className="border border-slate-800 bg-slate-950 p-3.5">
                  <div className="mb-1.5 font-bold uppercase text-amber-300">
                    ⚙️ Parâmetros do Esforço ({deskModalAgent.effort.toUpperCase()})
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] text-slate-300">
                    <div>
                      <span className="text-slate-500">Max Output:</span>{' '}
                      <strong className="font-mono text-white">
                        {deskModalEffortCfg.maxOutputTokens} tok
                      </strong>
                    </div>
                    <div>
                      <span className="text-slate-500">Thinking Budget:</span>{' '}
                      <strong className="font-mono text-white">
                        {deskModalEffortCfg.thinkingBudgetTokens} tok
                      </strong>
                    </div>
                    <div>
                      <span className="text-slate-500">Máx. Iterações Tools:</span>{' '}
                      <strong className="font-mono text-amber-300">
                        {deskModalEffortCfg.maxToolIterations} passos
                      </strong>
                    </div>
                    <div>
                      <span className="text-slate-500">Fontes de Pesquisa:</span>{' '}
                      <strong className="font-mono text-emerald-300">
                        até {deskModalEffortCfg.maxResearchSources}
                      </strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-5 flex justify-end border-t border-slate-800 pt-3">
              <button
                type="button"
                onClick={() => setDeskModalSlot(null)}
                className="border-2 border-emerald-400 bg-emerald-500 px-4 py-1.5 text-xs font-bold uppercase text-slate-950 hover:bg-emerald-400"
              >
                Fechar Detalhes da Mesa
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: Estante da Sala (Menu de Tabs Caixa de Entrada / Caixa de Saida + JSON Interativo) */}
      {shelfModalSlot && shelfModalAgent && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col border-2 border-amber-500 bg-slate-900 p-6 shadow-[8px_8px_0px_0px_rgba(245,158,11,0.28)]">
            <div className="mb-4 flex items-start justify-between border-b border-slate-800 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
                  📚 Estante da Sala // {shelfModalAgent.deskSlot.toUpperCase()}
                </span>
                <h3 className="text-lg font-bold text-white">
                  Estante de Artefatos — {shelfModalAgent.name} ({shelfModalAgent.roleName})
                </h3>
                <p className="text-xs text-slate-400">
                  Alterne entre Caixa de Entrada e Caixa de Saída para inspecionar os payloads JSON
                  e baixar os arquivos produzidos.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShelfModalSlot(null)}
                className="border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
              >
                ✕ Fechar
              </button>
            </div>

            {/* Menu de Tabs (substitui o layout 50/50 para leitura em largura total) */}
            <div
              role="tablist"
              aria-label="Caixas da Estante"
              className="mb-4 flex flex-wrap gap-2 border-b border-slate-800 pb-3 text-xs"
            >
              <button
                type="button"
                role="tab"
                aria-selected={shelfModalTab === 'inbox'}
                onClick={() => setShelfModalTab('inbox')}
                className={`flex items-center gap-2 border-2 px-4 py-2 font-bold uppercase tracking-wider transition-colors ${
                  shelfModalTab === 'inbox'
                    ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                    : 'border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                }`}
              >
                <span>📥 Caixa de Entrada</span>
                <span className="rounded border border-current/40 px-1.5 py-0 text-[10px]">
                  {shelfModalInbox.length}
                </span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={shelfModalTab === 'outbox'}
                onClick={() => setShelfModalTab('outbox')}
                className={`flex items-center gap-2 border-2 px-4 py-2 font-bold uppercase tracking-wider transition-colors ${
                  shelfModalTab === 'outbox'
                    ? 'border-emerald-400 bg-emerald-500/20 text-emerald-300'
                    : 'border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                }`}
              >
                <span>📤 Caixa de Saída</span>
                <span className="rounded border border-current/40 px-1.5 py-0 text-[10px]">
                  {shelfModalOutbox.length}
                </span>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1 text-xs">
              {shelfModalTab === 'inbox' ? (
                <div className="border border-slate-800 bg-slate-950 p-4">
                  <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="font-bold uppercase tracking-wider text-amber-300">
                      📥 Caixa de Entrada na Estante ({shelfModalInbox.length})
                    </span>
                    <span className="text-[10px] text-slate-400">
                      Inputs recebidos nesta sala
                    </span>
                  </div>

                  {shelfModalInbox.length === 0 ? (
                    <div className="border border-dashed border-slate-800 p-8 text-center text-slate-500">
                      Nenhum item na Caixa de Entrada desta estante no momento.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {shelfModalInbox.map((art) => (
                        <div key={art.id} className="border border-slate-800 bg-slate-900 p-3.5">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-sm font-bold text-amber-200">{art.title}</div>
                              <div className="text-[10px] text-slate-400">
                                {art.fromOrTo} • {art.timestamp} • Tipo:{' '}
                                <code className="text-amber-300">{art.kind}</code>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => setPreviewArtifact(art)}
                              className="shrink-0 border border-amber-400/70 bg-amber-500/20 px-2.5 py-1 text-[10px] font-bold uppercase text-amber-300 hover:border-amber-400"
                            >
                              Ver / Baixar
                            </button>
                          </div>
                          {art.metadata && (
                            <InteractiveJsonViewer
                              data={art.metadata}
                              initialExpandDepth={3}
                              maxHeightClassName="max-h-80"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="border border-slate-800 bg-slate-950 p-4">
                  <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="font-bold uppercase tracking-wider text-emerald-400">
                      📤 Caixa de Saída Detalhada ({shelfModalOutbox.length})
                    </span>
                    <span className="text-[10px] text-slate-400">
                      Artefatos produzidos e entregues por este agente
                    </span>
                  </div>

                  {shelfModalOutbox.length === 0 ? (
                    <div className="border border-dashed border-slate-800 p-8 text-center text-slate-500">
                      Nenhum artefato produzido na Caixa de Saída desta sala ainda.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {shelfModalOutbox.map((art) => (
                        <div key={art.id} className="border border-slate-800 bg-slate-900 p-3.5">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-sm font-bold text-emerald-300">{art.title}</div>
                              <div className="text-[10px] text-slate-400">
                                {art.fromOrTo} • {art.timestamp} • Tipo:{' '}
                                <code className="text-emerald-300">{art.kind}</code>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => setPreviewArtifact(art)}
                              className="shrink-0 border border-emerald-400/70 bg-emerald-500/20 px-2.5 py-1 text-[10px] font-bold uppercase text-emerald-300 hover:border-emerald-400"
                            >
                              ⬇ Preview / Baixar
                            </button>
                          </div>
                          {art.metadata && (
                            <InteractiveJsonViewer
                              data={art.metadata}
                              initialExpandDepth={3}
                              maxHeightClassName="max-h-80"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end border-t border-slate-800 pt-3">
              <button
                type="button"
                onClick={() => setShelfModalSlot(null)}
                className="border-2 border-amber-400 bg-amber-500 px-4 py-1.5 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400"
              >
                Fechar Estante
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: Detalhes do Log de Atividades (Evento, Telemetria LLM e Trace Completo) */}
      {activityDetailModalItem && selectedAgent && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto border-2 border-amber-500 bg-slate-900 p-6 shadow-[8px_8px_0px_0px_rgba(245,158,11,0.28)]">
            <div className="mb-4 flex items-start justify-between border-b border-slate-800 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
                  📋 Inspetor de Detalhes do Log de Atividades
                </span>
                <h3 className="text-lg font-bold text-white">
                  {activityDetailModalItem === 'all_agent_logs'
                    ? `Histórico Detalhado de Atividades — ${selectedAgent.name}`
                    : `${EVENT_VISUAL_CATALOG[activityDetailModalItem.type].bubbleIcon} ${activityDetailModalItem.type} — ${activityDetailModalItem.agentName}`}
                </h3>
                <p className="text-xs text-slate-400">
                  {selectedAgent.roleName} ({selectedAgent.deskSlot}) •{' '}
                  {selectedAgent.provider.toUpperCase()} / {selectedAgent.model} (esforço{' '}
                  {selectedAgent.effort})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActivityDetailModalItem(null)}
                className="border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
              >
                ✕ Fechar
              </button>
            </div>

            {activityDetailModalItem !== 'all_agent_logs' ? (
              <div className="space-y-4 text-xs">
                <div className="border border-slate-800 bg-slate-950 p-4">
                  <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
                    <span>
                      Evento:{' '}
                      <strong className="font-mono text-amber-300">
                        {activityDetailModalItem.type}
                      </strong>
                    </span>
                    <span>Horário: {activityDetailModalItem.timestamp}</span>
                  </div>
                  <div className="text-sm font-bold text-white">
                    {activityDetailModalItem.message}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-300">
                    <span className="border border-slate-800 bg-slate-900 px-2 py-0.5">
                      Hotspot Alvo:{' '}
                      <strong>
                        {EVENT_VISUAL_CATALOG[activityDetailModalItem.type].targetHotspot}
                      </strong>
                    </span>
                    <span className="border border-slate-800 bg-slate-900 px-2 py-0.5">
                      Animação:{' '}
                      <strong>
                        {EVENT_VISUAL_CATALOG[activityDetailModalItem.type].animationKey}
                      </strong>
                    </span>
                    {typeof activityDetailModalItem.progress === 'number' && (
                      <span className="border border-emerald-500/40 bg-emerald-950/40 px-2 py-0.5 text-emerald-300">
                        Progresso: {activityDetailModalItem.progress}%
                      </span>
                    )}
                  </div>
                </div>

                <div className="border border-slate-800 bg-slate-950 p-4">
                  <div className="mb-2 font-bold uppercase text-emerald-300">
                    ⚡ Telemetria de Chamadas LLM &amp; Tarefas Associadas a {selectedAgent.name}
                  </div>
                  <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
                    {syntheticCalls.filter((c) => c.agent_id === selectedAgent.id).length === 0 ? (
                      <div className="text-slate-500">
                        Nenhuma chamada LLM registrada ainda para este agente.
                      </div>
                    ) : (
                      syntheticCalls
                        .filter((c) => c.agent_id === selectedAgent.id)
                        .slice(0, 8)
                        .map((call, idx) => (
                          <div
                            key={`${call.id ?? idx}`}
                            className="border border-slate-800 bg-slate-900 p-2.5 font-mono text-[11px]"
                          >
                            <div className="flex flex-wrap justify-between text-emerald-300">
                              <span>
                                {call.provider}/{call.model} ({call.effort})
                              </span>
                              <span>
                                ${Number(call.cost_usd).toFixed(5)} USD • {call.latency_ms}ms
                              </span>
                            </div>
                            <div className="mt-1 text-slate-400">
                              Tokens — Input: {call.input_tokens} | Output: {call.output_tokens} |
                              Reasoning: {call.reasoning_tokens}
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="max-h-[60vh] space-y-2.5 overflow-y-auto pr-1 text-xs">
                {selectedLogs.length === 0 ? (
                  <div className="border border-dashed border-slate-800 p-6 text-center text-slate-500">
                    Nenhuma atividade registrada para {selectedAgent.name} ainda.
                  </div>
                ) : (
                  selectedLogs.map((logItem) => (
                    <div key={logItem.id} className="border border-slate-800 bg-slate-950 p-3">
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span className="font-mono font-bold text-amber-300">
                          {EVENT_VISUAL_CATALOG[logItem.type].bubbleIcon} {logItem.type}
                        </span>
                        <span>{logItem.timestamp}</span>
                      </div>
                      <div className="mt-1 text-slate-200">{logItem.message}</div>
                      <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] text-slate-400">
                        <span>
                          Destino: <code>{EVENT_VISUAL_CATALOG[logItem.type].targetHotspot}</code>
                        </span>
                        <span>•</span>
                        <span>
                          Animação: <code>{EVENT_VISUAL_CATALOG[logItem.type].animationKey}</code>
                        </span>
                        {typeof logItem.progress === 'number' && (
                          <>
                            <span>•</span>
                            <span className="text-emerald-400">Progresso: {logItem.progress}%</span>
                          </>
                        )}
                      </div>
                    </div>
                  ))
                )}

                {syntheticTasks.filter((t) => t.agent_id === selectedAgent.id).length > 0 && (
                  <div className="mt-4 border-t border-slate-800 pt-3">
                    <div className="mb-2 font-bold uppercase text-amber-300">
                      Payloads JSON das Tarefas Concluídas ({selectedAgent.name}):
                    </div>
                    {syntheticTasks
                      .filter((t) => t.agent_id === selectedAgent.id)
                      .slice(0, 6)
                      .map((tk) => (
                        <div key={tk.id} className="mb-2 border border-slate-800 bg-slate-950 p-3">
                          <div className="mb-1 font-mono text-[11px] text-emerald-300">
                            Task #{tk.id} • Status: {tk.status}
                          </div>
                          <InteractiveJsonViewer
                            data={{ input: tk.input, output: tk.output }}
                            initialExpandDepth={2}
                            maxHeightClassName="max-h-56"
                          />
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}

            <div className="mt-5 flex justify-end border-t border-slate-800 pt-3">
              <button
                type="button"
                onClick={() => setActivityDetailModalItem(null)}
                className="border-2 border-amber-400 bg-amber-500 px-4 py-1.5 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400"
              >
                Fechar Detalhes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 1. HEADER UNICO: Indicadores do Escritorio + Comandos */}
      <header className="border-2 border-amber-500/80 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
                {subtitleBadge}
              </span>
              {officeId && (
                <span
                  className={`border px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                    connectionStatus === 'SUBSCRIBED'
                      ? 'border-emerald-500/60 bg-emerald-950/60 text-emerald-300'
                      : 'border-amber-500/60 bg-amber-950/60 text-amber-300'
                  }`}
                >
                  {connectionStatus === 'SUBSCRIBED'
                    ? '● Supabase Realtime Ativo'
                    : '◌ Conectando Realtime...'}
                </span>
              )}
            </div>
            <h1 className="text-xl font-bold text-white">{officeName}</h1>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div className="border border-slate-800 bg-slate-950 px-3 py-1.5">
              <div className="text-[10px] uppercase text-slate-400">Equipe Simultânea</div>
              <div className="font-bold text-white">
                <span className="text-emerald-400">{workingCount} trabalhando</span> •{' '}
                <span className="text-slate-400">{restingCount} copa</span>
              </div>
            </div>
            <div className="border border-slate-800 bg-slate-950 px-3 py-1.5">
              <div className="text-[10px] uppercase text-slate-400">Custo Escritório (Dia)</div>
              <div className="font-bold text-emerald-400">${officeDailyCostUsd.toFixed(4)} USD</div>
            </div>
            <div className="border border-slate-800 bg-slate-950 px-3 py-1.5">
              <div className="text-[10px] uppercase text-slate-400">Tokens no Dia</div>
              <div className="font-bold text-white">{officeTotalTokens.toLocaleString()} tok</div>
            </div>
            <div className="border border-slate-800 bg-slate-950 px-3 py-1.5">
              <div className="text-[10px] uppercase text-slate-400">Entregas nas Estantes</div>
              <div className="font-bold text-amber-300">{officeArtifactsCount} entregas</div>
            </div>
          </div>

          {headerActions ?? (
            <div className="flex items-center gap-2">
              <Link
                href="/app/new-office"
                className="border border-amber-400/80 bg-amber-950/40 px-3 py-1.5 text-xs font-bold uppercase text-amber-300 hover:border-amber-400"
              >
                + Novo Escritório
              </Link>
              <Link
                href="/app"
                className="border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
              >
                ← Painel
              </Link>
            </div>
          )}
        </div>

        {/* Barra de Comandos do Escritorio */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex min-w-[280px] flex-1 items-center gap-2">
            <span className="shrink-0 font-bold uppercase text-amber-400">
              Instrução ao Roteirista:
            </span>
            <input
              type="text"
              value={instructionInput}
              onChange={(e) => setInstructionInput(e.target.value)}
              placeholder="Ex: Crie 10 vídeos do vídeo game novo"
              className="w-full border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-amber-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleDispatchInstructionToScriptwriter}
              className="shrink-0 border-2 border-emerald-400 bg-emerald-500 px-3.5 py-1.5 text-xs font-bold uppercase text-slate-950 hover:bg-emerald-400"
            >
              Enviar Instrução
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const nextClean =
                  instructionInput.trim() ||
                  activeInstruction.trim() ||
                  'Crie 3 vídeos sobre o tema solicitado';
                if (nextClean !== activeInstruction) {
                  setActiveInstruction(nextClean);
                }
                if (!isPlaying && currentStepIdx >= scenarioSteps.length - 1) {
                  handleResetSimulation();
                }
                if (!isPlaying && currentStepIdx === -1) {
                  if (officeId) {
                    void handleDispatchInstructionToScriptwriter();
                    return;
                  }
                  advanceScenarioStep(0);
                }
                setIsPlaying((prev) => !prev);
              }}
              className="border-2 border-amber-400 bg-amber-500 px-3.5 py-1.5 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400"
            >
              {isPlaying ? '⏸ Pausar' : '▶ Simular Simultâneo'}
            </button>

            <button
              type="button"
              disabled={isPlaying || currentStepIdx >= scenarioSteps.length - 1}
              onClick={() => advanceScenarioStep(currentStepIdx + 1)}
              className="border border-emerald-400 bg-emerald-950/60 px-3 py-1.5 text-xs font-bold uppercase text-emerald-300 hover:bg-emerald-900/60 disabled:opacity-40"
            >
              ⏭ Onda ({Math.max(0, currentStepIdx + 1)}/{scenarioSteps.length})
            </button>

            {replayHistory.length > 0 && (
              <button
                type="button"
                onClick={handleStartReplayHistory}
                className="border border-amber-400/70 bg-amber-950/40 px-2.5 py-1.5 text-xs font-bold uppercase text-amber-300 hover:border-amber-400"
                title="Reproduz na timeline os eventos reais gravados no banco"
              >
                ⏮ Replay DB ({replayHistory.length})
              </button>
            )}

            <button
              type="button"
              onClick={handleSendAllAgentsToRest}
              className="border border-red-500/80 bg-red-950/60 px-2.5 py-1.5 text-xs font-bold uppercase text-red-200 hover:border-red-400"
            >
              🛑 Descansar Todos
            </button>

            <button
              type="button"
              onClick={handleResetSimulation}
              className="border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
            >
              ↺ Reiniciar
            </button>

            <div className="flex items-center gap-1 border-l border-slate-700 pl-2">
              {([1, 2, 4] as const).map((spd) => (
                <button
                  key={spd}
                  type="button"
                  onClick={() => setPlaybackSpeed(spd)}
                  className={`border px-2 py-0.5 font-bold ${
                    playbackSpeed === spd
                      ? 'border-amber-400 bg-amber-500 text-slate-950'
                      : 'border-slate-700 bg-slate-800 text-slate-300'
                  }`}
                >
                  {spd}x
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* 2. CORPO PRINCIPAL: 70% Display Visual do Escritorio (7 cols) | 30% Ficha do Funcionario (3 cols) */}
      <div className="grid gap-4 lg:grid-cols-10">
        <div className="lg:col-span-7">
          <OfficeGameCanvas
            agents={agents}
            activeStates={activeStates}
            visualCommandLog={visualCommandLog}
            selectedAgentId={selectedAgentId}
            onSelectAgent={(id) => setSelectedAgentId(id)}
            onClickDesk={(slot) => setDeskModalSlot(slot)}
            onClickShelf={(slot) => {
              setShelfModalSlot(slot);
              const ag = agents.find((a) => a.deskSlot === slot);
              const hasIn = ag ? (inboxByAgent[ag.id]?.length ?? 0) > 0 : false;
              const hasOut = ag ? (outboxByAgent[ag.id]?.length ?? 0) > 0 : false;
              setShelfModalTab(!hasIn && hasOut ? 'outbox' : 'inbox');
            }}
            playbackSpeed={playbackSpeed}
          />
        </div>

        <aside className="flex flex-col justify-between border-2 border-slate-700 bg-slate-900 p-4 lg:col-span-3">
          {selectedAgent && (
            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                  Funcionário Selecionado
                </span>
                <div className="flex gap-1">
                  {agents.map((ag) => (
                    <button
                      key={ag.id}
                      type="button"
                      onClick={() => setSelectedAgentId(ag.id)}
                      className={`border px-2 py-0.5 text-[10px] font-bold uppercase ${
                        ag.id === selectedAgent.id
                          ? 'border-amber-400 bg-amber-500 text-slate-950'
                          : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      {ag.deskSlot.replace('desk_', 'B')}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 border border-slate-800 bg-slate-950 p-2.5">
                <div className="flex h-16 w-14 shrink-0 items-center justify-center border border-amber-500/40 bg-slate-900 p-1">
                  <img
                    src={selectedSpriteInfo.portraitAsset}
                    alt={selectedAgent.name}
                    className="h-full w-full object-contain"
                    style={{ imageRendering: 'pixelated' }}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-bold uppercase text-amber-400">
                    {selectedAgent.roleName} // {selectedAgent.deskSlot}
                  </div>
                  <div className="truncate text-sm font-bold text-white">{selectedAgent.name}</div>
                  <div className="text-[11px] text-emerald-400">
                    {selectedAgent.provider.toUpperCase()} • {selectedAgent.model}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Esforço: <strong className="uppercase text-white">{selectedAgent.effort}</strong>{' '}
                    | Status:{' '}
                    <span className="text-amber-300">
                      {selectedMapping.bubbleIcon} {selectedVisualState?.eventType ?? 'agent.idle'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Custos: Ultima Tarefa, Media das Tarefas e Custo no Dia */}
              <div className="grid grid-cols-3 gap-1.5">
                <div className="border border-slate-800 bg-slate-950 p-2">
                  <div className="text-[9px] uppercase text-slate-400">Última Tarefa</div>
                  <div className="mt-0.5 font-mono text-xs font-bold text-white">
                    ${selectedCostStats.lastTaskCostUsd.toFixed(4)}
                  </div>
                </div>
                <div className="border border-slate-800 bg-slate-950 p-2">
                  <div className="text-[9px] uppercase text-slate-400">Média / Tarefa</div>
                  <div className="mt-0.5 font-mono text-xs font-bold text-amber-300">
                    ${selectedAvgTaskCostUsd.toFixed(4)}
                  </div>
                </div>
                <div className="border border-slate-800 bg-slate-950 p-2">
                  <div className="text-[9px] uppercase text-slate-400">Custo no Dia</div>
                  <div className="mt-0.5 font-mono text-xs font-bold text-emerald-400">
                    ${selectedCostStats.dailyCostUsd.toFixed(4)}
                  </div>
                </div>
              </div>

              {/* Comandos do Funcionario */}
              <div className="border border-slate-800 bg-slate-950 p-2.5">
                <div className="mb-1.5 text-[10px] font-bold uppercase text-slate-400">
                  Comandos de {selectedAgent.name}:
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() =>
                      dispatchVisualAction({
                        agentId: selectedAgent.id,
                        agentName: selectedAgent.name,
                        roleSlug: selectedAgent.roleSlug,
                        type: 'handoff.received',
                        message: `${selectedAgent.name} foi pegar um novo input na sua própria estante (${selectedAgent.deskSlot}).`,
                        tokensUsedDelta: 120,
                        costUsdDelta: 0.0003,
                      })
                    }
                    className="border border-slate-700 bg-slate-900 px-2 py-1 text-left font-bold text-slate-200 hover:border-amber-400"
                  >
                    📥 Pegar na Estante
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      dispatchVisualAction({
                        agentId: selectedAgent.id,
                        agentName: selectedAgent.name,
                        roleSlug: selectedAgent.roleSlug,
                        type: 'task.started',
                        message: `${selectedAgent.name} sentou no computador da ${selectedAgent.deskSlot} para trabalhar no vídeo.`,
                        tokensUsedDelta: 420,
                        costUsdDelta: 0.0012,
                      })
                    }
                    className="border border-slate-700 bg-slate-900 px-2 py-1 text-left font-bold text-slate-200 hover:border-amber-400"
                  >
                    ▶️ Trabalhar (CRT)
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      dispatchVisualAction({
                        agentId: selectedAgent.id,
                        agentName: selectedAgent.name,
                        roleSlug: selectedAgent.roleSlug,
                        type: 'handoff.sent',
                        targetDeskSlot: nextDeskForSelected,
                        message: `${selectedAgent.name} saiu da sua sala e foi entregar 1 vídeo na estante da ${nextDeskForSelected}.`,
                        tokensUsedDelta: 0,
                        costUsdDelta: 0,
                      })
                    }
                    className="border border-slate-700 bg-slate-900 px-2 py-1 text-left font-bold text-slate-200 hover:border-amber-400"
                  >
                    📄 Entregar ({nextDeskForSelected})
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSendAgentToRest(selectedAgent.id)}
                    className="border border-red-500/70 bg-red-950/50 px-2 py-1 text-left font-bold text-red-200 hover:border-red-400"
                  >
                    🛑 Descansar (Copa)
                  </button>
                </div>
              </div>

              {/* Caixa de Entrada (Estante) e Caixa de Saida com Clique para Preview/Download */}
              <div className="grid grid-cols-1 gap-2">
                <div className="border border-slate-800 bg-slate-950 p-2.5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase text-amber-300">
                      📥 Caixa de Entrada / Estante ({selectedInbox.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => setShelfModalSlot(selectedAgent.deskSlot)}
                      className="border border-amber-500/50 bg-amber-950/40 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-300 hover:border-amber-400"
                    >
                      📚 Abrir Estante
                    </button>
                  </div>
                  <div className="max-h-24 space-y-1 overflow-y-auto text-[11px]">
                    {selectedInbox.length === 0 ? (
                      <div className="text-slate-500">Estante vazia no momento.</div>
                    ) : (
                      selectedInbox.map((art) => (
                        <button
                          key={art.id}
                          type="button"
                          onClick={() => setPreviewArtifact(art)}
                          className="flex w-full items-center justify-between gap-2 border-b border-slate-900 pb-1 text-left hover:bg-slate-900/80"
                        >
                          <span className="truncate text-slate-200 underline decoration-amber-500/40">
                            {art.title}
                          </span>
                          <span className="shrink-0 text-[9px] text-amber-400">Ver / Baixar</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>

                <div className="border border-slate-800 bg-slate-950 p-2.5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase text-emerald-400">
                      📤 Caixa de Saída ({selectedOutbox.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => setDeskModalSlot(selectedAgent.deskSlot)}
                      className="border border-emerald-500/50 bg-emerald-950/40 px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-300 hover:border-emerald-400"
                    >
                      💻 Mesa &amp; Contexto
                    </button>
                  </div>
                  <div className="max-h-24 space-y-1 overflow-y-auto text-[11px]">
                    {selectedOutbox.length === 0 ? (
                      <div className="text-slate-500">Nenhum vídeo entregue ainda.</div>
                    ) : (
                      selectedOutbox.map((art) => (
                        <button
                          key={art.id}
                          type="button"
                          onClick={() => setPreviewArtifact(art)}
                          className="flex w-full items-center justify-between gap-2 border-b border-slate-900 pb-1 text-left hover:bg-slate-900/80"
                        >
                          <span className="truncate text-emerald-300 underline decoration-emerald-500/40">
                            {art.title}
                          </span>
                          <span className="shrink-0 text-[9px] text-emerald-400">
                            ⬇ Preview
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Log de Atividades do Funcionario com Botao de Exibir Modal de Detalhes */}
              <div className="border border-slate-800 bg-slate-950 p-2.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase text-slate-400">
                    📋 Log de Atividades ({selectedLogs.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => setActivityDetailModalItem('all_agent_logs')}
                    className="border border-amber-500/60 bg-amber-950/40 px-2 py-0.5 text-[9px] font-bold uppercase text-amber-300 hover:border-amber-400"
                  >
                    🔍 Exibir Detalhes
                  </button>
                </div>
                <div className="max-h-28 space-y-1 overflow-y-auto pr-1 text-[11px]">
                  {selectedLogs.length === 0 ? (
                    <div className="py-2 text-slate-500">
                      Nenhuma atividade registrada para este funcionário ainda.
                    </div>
                  ) : (
                    selectedLogs.map((item) => (
                      <div key={item.id} className="border-b border-slate-900 pb-1">
                        <div className="flex items-center justify-between text-[9px] text-slate-400">
                          <span className="font-mono text-amber-300">
                            {EVENT_VISUAL_CATALOG[item.type].bubbleIcon} {item.type}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <span>{item.timestamp}</span>
                            <button
                              type="button"
                              onClick={() => setActivityDetailModalItem(item)}
                              className="border border-slate-700 bg-slate-900 px-1.5 py-0.2 text-[9px] font-bold uppercase text-amber-300 hover:border-amber-400"
                            >
                              Detalhes
                            </button>
                          </div>
                        </div>
                        <div className="text-slate-200">{item.message}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* 3. PAINEL DE OBSERVABILIDADE, TRACES E CONTROLE DE ORCAMENTO (ETAPA 8) */}
      <OfficeObservabilityPanel
        officeId={officeId}
        agents={agents}
        syntheticCalls={syntheticCalls}
        syntheticTasks={syntheticTasks}
        publishedShortsCount={Math.max(1, officeArtifactsCount)}
        runsCount={runsCount}
        onTriggerBudgetAction={handleTriggerBudgetAction}
      />
    </section>
  );
}
