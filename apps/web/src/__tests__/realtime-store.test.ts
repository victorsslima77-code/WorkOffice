import { describe, expect, it } from 'vitest';
import type { VisualOfficeAgent } from '@workoffice/shared';
import {
  reconstructInitialStatesFromEvents,
  type PersistedAgentEventRow,
} from '../lib/stores/office-realtime-store';

describe('@workoffice/web — Etapa 7 (Reconstrucao de Estado Inicial Realtime e Replay)', () => {
  const agents: VisualOfficeAgent[] = [
    {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Lucas Roteirista',
      roleSlug: 'scriptwriter',
      roleName: 'Roteirista / Pesquisador',
      deskSlot: 'desk_1',
      spriteKey: 'character_1',
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      effort: 'low',
      monthlyTokenBudget: 500000,
      status: 'idle',
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Marina Editora',
      roleSlug: 'video_editor',
      roleName: 'Editor de Vídeo',
      deskSlot: 'desk_2',
      spriteKey: 'character_2',
      provider: 'google',
      model: 'gemini-2.5-pro',
      effort: 'high',
      monthlyTokenBudget: 1500000,
      status: 'idle',
    },
  ];

  it('reconstroi a posicao e o estado visual inicial de cada agente a partir do seu ultimo evento no banco', () => {
    const dbEvents: PersistedAgentEventRow[] = [
      {
        id: 10,
        office_id: 'off-1',
        agent_id: agents[0]!.id,
        task_id: 't-1',
        type: 'task.started',
        payload: { message: 'Iniciou Vídeo #1', videoNumber: 1, totalVideos: 3 },
        created_at: new Date().toISOString(),
      },
      {
        id: 15,
        office_id: 'off-1',
        agent_id: agents[0]!.id,
        task_id: 't-1',
        type: 'handoff.sent',
        payload: {
          message: 'Entregando na estante da Baia 2',
          targetDeskSlot: 'desk_2',
          videoNumber: 1,
          totalVideos: 3,
        },
        created_at: new Date().toISOString(),
      },
      {
        id: 16,
        office_id: 'off-1',
        agent_id: agents[1]!.id,
        task_id: 't-2',
        type: 'edit.cut',
        payload: {
          message: 'Cortando Short #1 em 9:16',
          progress: 65,
          videoNumber: 1,
          totalVideos: 3,
        },
        created_at: new Date().toISOString(),
      },
    ];

    const reconstructed = reconstructInitialStatesFromEvents(agents, dbEvents);
    expect(reconstructed[agents[0]!.id]?.eventType).toBe('handoff.sent');
    expect(reconstructed[agents[0]!.id]?.targetDeskSlot).toBe('desk_2');
    expect(reconstructed[agents[1]!.id]?.eventType).toBe('edit.cut');
    expect(reconstructed[agents[1]!.id]?.progress).toBe(65);
  });
});
