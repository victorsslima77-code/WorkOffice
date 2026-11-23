import { describe, expect, it } from 'vitest';
import {
  buildMockShortsScenarioSteps,
  DEFAULT_OFFICE_MAP_LAYOUT,
  parseRequestedVideoCount,
  resolveEventTargetGrid,
  type VisualOfficeAgent,
} from '../index.js';

describe('@workoffice/shared — Etapa 4 (Entregas na Estante e Execucao Simultanea)', () => {
  it('garante que todos os hotspots do mapa office.png caem em celulas caminhaveis (grid === 0)', () => {
    const { grid, hotspots } = DEFAULT_OFFICE_MAP_LAYOUT;

    const pointsToCheck = [
      hotspots.spawn_door,
      hotspots.meeting_table,
      hotspots.whiteboard,
      hotspots.coffee_machine,
      hotspots.foosball,
      hotspots.desk_1.chair,
      hotspots.desk_1.shelf,
      hotspots.desk_2.chair,
      hotspots.desk_2.shelf,
      hotspots.desk_3.chair,
      hotspots.desk_3.shelf,
    ];

    for (const pt of pointsToCheck) {
      expect(grid[pt.row]?.[pt.col]).toBe(0);
    }
  });

  it('direciona handoff.sent para a estante do funcionario destinatario e handoff.received para a propria estante', () => {
    // Roteirista (desk_1) entregando para Editor (desk_2) -> vai ate a estante da Baia 2 (col 28, row 12)
    const deliverToEditorShelf = resolveEventTargetGrid(
      'handoff.sent',
      'desk_1',
      0,
      DEFAULT_OFFICE_MAP_LAYOUT,
      'desk_2',
    );
    expect(deliverToEditorShelf.col).toBe(28);
    expect(deliverToEditorShelf.row).toBe(12);

    // Editor (desk_2) entregando para Publicador (desk_3) -> vai ate a estante da Baia 3 (col 28, row 18)
    const deliverToPublisherShelf = resolveEventTargetGrid(
      'handoff.sent',
      'desk_2',
      1,
      DEFAULT_OFFICE_MAP_LAYOUT,
      'desk_3',
    );
    expect(deliverToPublisherShelf.col).toBe(28);
    expect(deliverToPublisherShelf.row).toBe(18);

    // Editor (desk_2) pegando tarefa para comecar (handoff.received) -> vai ate sua propria estante (col 28, row 12)
    const pickFromOwnShelf = resolveEventTargetGrid('handoff.received', 'desk_2', 1);
    expect(pickFromOwnShelf.col).toBe(28);
    expect(pickFromOwnShelf.row).toBe(12);
  });

  it('extrai a quantidade de videos da instrucao e gera ondas simultaneas onde os 3 agentes trabalham ao mesmo tempo', () => {
    expect(parseRequestedVideoCount('Crie 10 vídeos do vídeo game novo')).toBe(10);
    expect(parseRequestedVideoCount('Faca 4 cortes sobre IA')).toBe(4);
    expect(
      parseRequestedVideoCount('Crie um video curto do youtuber Davy Jones falando sobre GTA 6'),
    ).toBe(1);
    expect(
      parseRequestedVideoCount('Crie um video curto do youtuber Davy Jones falando sobre GTA'),
    ).toBe(1);

    const mockAgents: VisualOfficeAgent[] = [
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
      {
        id: '33333333-3333-3333-3333-333333333333',
        name: 'Rafael Publicador',
        roleSlug: 'publisher_analyst',
        roleName: 'Publicador / Analista',
        deskSlot: 'desk_3',
        spriteKey: 'character_3',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        effort: 'low',
        monthlyTokenBudget: 300000,
        status: 'idle',
      },
    ];

    const steps = buildMockShortsScenarioSteps(mockAgents, 'Crie 4 vídeos do vídeo game novo');
    // Verifica que existem passos onde todos os 3 agentes atuam simultaneamente (1 primary + 2 concurrentActions)
    const threeWayConcurrentSteps = steps.filter(
      (s) => (s.concurrentActions?.length ?? 0) === 2,
    );
    expect(threeWayConcurrentSteps.length).toBeGreaterThanOrEqual(4);
  });
});
