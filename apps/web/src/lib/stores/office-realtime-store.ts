import type {
  AgentEventType,
  DeskSlot,
  VisualOfficeAgent,
} from '@workoffice/shared';
import { create } from 'zustand';
import type { ActiveAgentVisualState } from '@/components/office-game-canvas';

export interface PersistedAgentEventRow {
  id: number;
  office_id: string;
  agent_id: string;
  task_id: string | null;
  type: AgentEventType;
  payload: {
    message?: string;
    progress?: number;
    targetDeskSlot?: DeskSlot;
    videoNumber?: number;
    totalVideos?: number;
    [key: string]: unknown;
  };
  created_at: string;
}

/**
 * Reconstroi o estado visual inicial de cada agente ao abrir ou recarregar a pagina
 * a partir do ultimo evento persistido de cada agente no banco.
 */
export function reconstructInitialStatesFromEvents(
  agents: readonly VisualOfficeAgent[],
  eventsDescOrAsc: readonly PersistedAgentEventRow[],
): Record<string, ActiveAgentVisualState> {
  const states: Record<string, ActiveAgentVisualState> = {};

  for (const ag of agents) {
    states[ag.id] = {
      eventType: 'agent.idle',
      message:
        ag.roleSlug === 'scriptwriter'
          ? 'Descansando na copa até receber uma instrução.'
          : 'Descansando na copa até receber input na sua estante.',
    };
  }

  // Ordena crescente por id para que o evento mais recente sobrescreva os anteriores
  const sortedAsc = [...eventsDescOrAsc].sort((a, b) => a.id - b.id);
  for (const ev of sortedAsc) {
    if (!states[ev.agent_id]) continue;
    states[ev.agent_id] = {
      eventType: ev.type,
      message: ev.payload?.message ?? ev.type,
      progress: typeof ev.payload?.progress === 'number' ? ev.payload.progress : undefined,
      targetDeskSlot: ev.payload?.targetDeskSlot,
      videoNumber:
        typeof ev.payload?.videoNumber === 'number' ? ev.payload.videoNumber : undefined,
      totalVideos:
        typeof ev.payload?.totalVideos === 'number' ? ev.payload.totalVideos : undefined,
    };
  }

  return states;
}

export interface OfficeRealtimeState {
  connectionStatus: 'idle' | 'connecting' | 'SUBSCRIBED' | 'error';
  lastSyncedEventId: number;
  replayHistory: PersistedAgentEventRow[];
  replayCursor: number;
  isReplayingHistory: boolean;
  setConnectionStatus: (status: OfficeRealtimeState['connectionStatus']) => void;
  setLastSyncedEventId: (id: number) => void;
  setReplayHistory: (events: PersistedAgentEventRow[]) => void;
  setReplayCursor: (cursor: number) => void;
  setIsReplayingHistory: (active: boolean) => void;
}

export const useOfficeRealtimeStore = create<OfficeRealtimeState>((set) => ({
  connectionStatus: 'idle',
  lastSyncedEventId: 0,
  replayHistory: [],
  replayCursor: -1,
  isReplayingHistory: false,
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setLastSyncedEventId: (lastSyncedEventId) => set({ lastSyncedEventId }),
  setReplayHistory: (replayHistory) => set({ replayHistory }),
  setReplayCursor: (replayCursor) => set({ replayCursor }),
  setIsReplayingHistory: (isReplayingHistory) => set({ isReplayingHistory }),
}));
