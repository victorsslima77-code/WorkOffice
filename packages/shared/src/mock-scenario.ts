import { EVENT_VISUAL_CATALOG, type AgentEventType } from './events.js';
import type { EffortLevel, LlmProvider } from './models.js';
import type { SpriteKey } from './office.js';
import {
  planYoutubeShortPublication,
  type DeskSlot,
  type RoleSlug,
} from './roles.js';

export interface GridCoordinate {
  col: number;
  row: number;
  facing: 'down' | 'up' | 'left' | 'right' | 'up_left' | 'up_right';
  label: string;
}

export interface OfficeMapLayout {
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  imageWidth: number;
  imageHeight: number;
  grid: number[][];
  hotspots: {
    spawn_door: GridCoordinate;
    meeting_table: GridCoordinate;
    whiteboard: GridCoordinate;
    coffee_machine: GridCoordinate;
    foosball: GridCoordinate;
    desk_1: { chair: GridCoordinate; shelf: GridCoordinate };
    desk_2: { chair: GridCoordinate; shelf: GridCoordinate };
    desk_3: { chair: GridCoordinate; shelf: GridCoordinate };
  };
}

export function createDefaultOfficeMapLayout(): OfficeMapLayout {
  const cols = 43;
  const rows = 24;
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1));

  const markRectWalkable = (c1: number, r1: number, c2: number, r2: number) => {
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r >= 0 && r < rows && c >= 0 && c < cols && grid[r]) {
          grid[r]![c] = 0;
        }
      }
    }
  };

  // Corredor central
  markRectWalkable(19, 8, 25, 19);
  // Sala de Reuniao
  markRectWalkable(15, 7, 18, 11);
  markRectWalkable(8, 9, 15, 11);
  // Copa / Descanso
  markRectWalkable(16, 15, 19, 17);
  markRectWalkable(9, 15, 16, 17);
  markRectWalkable(13, 17, 16, 20);
  // Baias 1, 2 e 3
  markRectWalkable(25, 6, 33, 8);
  markRectWalkable(25, 12, 33, 14);
  markRectWalkable(25, 18, 33, 20);

  return {
    cols,
    rows,
    tileWidth: 32,
    tileHeight: 32,
    imageWidth: 1376,
    imageHeight: 768,
    grid,
    hotspots: {
      spawn_door: { col: 21, row: 13, facing: 'down', label: 'Corredor Central' },
      meeting_table: { col: 15, row: 9, facing: 'up_left', label: 'Sala de Reunião' },
      whiteboard: { col: 16, row: 8, facing: 'up_left', label: 'Quadro Branco' },
      coffee_machine: { col: 10, row: 16, facing: 'up_left', label: 'Cafeteira (Copa)' },
      foosball: { col: 14, row: 19, facing: 'down', label: 'Mesa de Pebolim (Copa)' },
      desk_1: {
        chair: { col: 32, row: 7, facing: 'up_right', label: 'Baia 1 — Computador CRT' },
        shelf: { col: 28, row: 6, facing: 'up_left', label: 'Baia 1 — Estante de Pastas' },
      },
      desk_2: {
        chair: { col: 32, row: 13, facing: 'up_right', label: 'Baia 2 — Computador CRT' },
        shelf: { col: 28, row: 12, facing: 'up_left', label: 'Baia 2 — Estante de Pastas' },
      },
      desk_3: {
        chair: { col: 32, row: 19, facing: 'up_right', label: 'Baia 3 — Computador CRT' },
        shelf: { col: 28, row: 18, facing: 'up_left', label: 'Baia 3 — Estante de Pastas' },
      },
    },
  };
}

export const DEFAULT_OFFICE_MAP_LAYOUT = createDefaultOfficeMapLayout();

/**
 * Determina a baia do destinatario padrao no fluxo Roteirista (desk_1) -> Editor (desk_2) -> Publicador (desk_3).
 */
export function getDefaultNextDeskSlot(deskSlot: DeskSlot): DeskSlot {
  if (deskSlot === 'desk_1') return 'desk_2';
  if (deskSlot === 'desk_2') return 'desk_3';
  return 'desk_3';
}

/**
 * Resolve a coordenada de destino no grid 43x24 para qualquer tipo de evento visual:
 * - handoff.sent ('target_shelf'): caminha ate a estante do funcionario que recebera o input!
 * - handoff.received / research.read_source ('own_shelf'): caminha ate a sua propria estante para pegar o input!
 * - task.started / research.web_search / edit.* / publish.* ('own_desk'): senta no computador CRT da sua baia.
 */
export function resolveEventTargetGrid(
  eventType: AgentEventType,
  deskSlot: DeskSlot,
  agentSlotIndex = 0,
  layout: OfficeMapLayout = DEFAULT_OFFICE_MAP_LAYOUT,
  targetDeskSlot?: DeskSlot,
): GridCoordinate {
  const mapping = EVENT_VISUAL_CATALOG[eventType];
  const ownDesk = layout.hotspots[deskSlot] ?? layout.hotspots.desk_1;

  if (mapping.targetHotspot === 'own_desk') {
    return ownDesk.chair;
  }

  if (mapping.targetHotspot === 'own_shelf') {
    return ownDesk.shelf;
  }

  if (mapping.targetHotspot === 'target_shelf') {
    const destSlot = targetDeskSlot ?? getDefaultNextDeskSlot(deskSlot);
    const destDesk = layout.hotspots[destSlot] ?? layout.hotspots.desk_2;
    return destDesk.shelf;
  }

  if (mapping.targetHotspot === 'meeting_table') {
    const meetingSpots: GridCoordinate[] = [
      { col: 15, row: 9, facing: 'up_left', label: 'Sala de Reunião (Mesa)' },
      { col: 16, row: 8, facing: 'up_left', label: 'Sala de Reunião (Quadro)' },
      { col: 13, row: 10, facing: 'up_right', label: 'Sala de Reunião (Lateral)' },
    ];
    return meetingSpots[agentSlotIndex % meetingSpots.length]!;
  }

  const loungeSpots: GridCoordinate[] = [
    { col: 10, row: 16, facing: 'up_left', label: 'Copa (Cafeteira)' },
    { col: 14, row: 19, facing: 'down', label: 'Copa (Pebolim)' },
    { col: 12, row: 16, facing: 'down', label: 'Copa (Bancada)' },
  ];
  return loungeSpots[agentSlotIndex % loungeSpots.length]!;
}

export interface VisualOfficeAgent {
  id: string;
  name: string;
  roleSlug: RoleSlug;
  roleName: string;
  deskSlot: DeskSlot;
  spriteKey: SpriteKey;
  provider: LlmProvider;
  model: string;
  effort: EffortLevel;
  monthlyTokenBudget: number | null;
  status: 'idle' | 'working' | 'paused_budget' | 'error';
}

export interface MockScenarioAction {
  agentId: string;
  agentName: string;
  roleSlug: RoleSlug;
  type: AgentEventType;
  targetDeskSlot?: DeskSlot;
  videoNumber?: number;
  totalVideos?: number;
  artifactTitle?: string;
  message: string;
  progress?: number;
  tokensUsedDelta: number;
  costUsdDelta: number;
}

export interface MockScenarioStep extends MockScenarioAction {
  stepIndex: number;
  durationMs: number;
  /**
   * Acoes que acontecem simultaneamente no mesmo ciclo (ex: Roteirista escrevendo Video #2
   * enquanto Editor edita Video #1 e Publicador publica Video #1).
   */
  concurrentActions?: MockScenarioAction[];
}

export function parseRequestedVideoCount(instruction: string): number {
  const match = instruction.match(/\b(\d{1,2})\b/);
  if (!match?.[1]) return 3;
  const num = Number(match[1]);
  if (Number.isNaN(num) || num < 1) return 3;
  return Math.min(10, num);
}

/**
 * Gera os passos de execucao SIMULTANEA (pipeline continuo item a item):
 * - Roteirista produz 1 instrucao clara de edicao por vez, leva ate a estante do Editor (desk_2.shelf)
 *   e volta imediatamente para a Baia 1 para produzir o proximo video.
 * - Editor pega a instrucao na sua estante (desk_2.shelf), edita 1 video por vez no computador (desk_2.chair)
 *   e leva o video editado ate a estante do Publicador (desk_3.shelf) enquanto o Roteirista segue trabalhando.
 * - Publicador pega o video editado na sua estante (desk_3.shelf) e publica/monitora 1 video por vez no computador
 *   enquanto Roteirista e Editor continuam trabalhando nos videos seguintes.
 */
export function buildMockShortsScenarioSteps(
  agents: readonly VisualOfficeAgent[],
  userInstruction = 'Crie 10 vídeos do vídeo game novo',
): MockScenarioStep[] {
  const scriptwriter =
    agents.find((a) => a.roleSlug === 'scriptwriter') ??
    agents[0]!;
  const editor =
    agents.find((a) => a.roleSlug === 'video_editor') ??
    agents[1] ??
    agents[0]!;
  const publisher =
    agents.find((a) => a.roleSlug === 'publisher_analyst') ??
    agents[2] ??
    agents[0]!;

  const cleanInstruction = userInstruction.trim() || 'Crie 10 vídeos do vídeo game novo';
  const totalVideos = parseRequestedVideoCount(cleanInstruction);
  const steps: Omit<MockScenarioStep, 'stepIndex'>[] = [];

  // Pipeline em ondas (tick = 1 .. totalVideos + 2):
  // Na onda `w`:
  // - Roteirista produz o Video `vSw = w` (se 1 <= vSw <= totalVideos)
  // - Editor processa o Video `vEd = w - 1` (se 1 <= vEd <= totalVideos)
  // - Publicador publica o Video `vPub = w - 2` (se 1 <= vPub <= totalVideos)
  for (let wave = 1; wave <= totalVideos + 2; wave++) {
    const vSw = wave <= totalVideos ? wave : null;
    const vEd = wave - 1 >= 1 && wave - 1 <= totalVideos ? wave - 1 : null;
    const vPub = wave - 2 >= 1 && wave - 2 <= totalVideos ? wave - 2 : null;

    // FASE A DA ONDA: Retirada na propria estante (Editor/Publicador) + Inicio no Roteirista (Simultaneos!)
    const phaseAActions: MockScenarioAction[] = [];

    if (vSw !== null) {
      phaseAActions.push({
        agentId: scriptwriter.id,
        agentName: scriptwriter.name,
        roleSlug: scriptwriter.roleSlug,
        type: vSw === 1 ? 'task.started' : 'research.web_search',
        videoNumber: vSw,
        totalVideos,
        message:
          vSw === 1
            ? `Instrução recebida ("${cleanInstruction}"). Iniciando pesquisa do Vídeo #${vSw}/${totalVideos} na Baia 1.`
            : `Continuando trabalho na Baia 1: pesquisando e estruturando o Vídeo #${vSw}/${totalVideos}...`,
        progress: Math.round(((vSw - 0.5) / totalVideos) * 100),
        tokensUsedDelta: 850,
        costUsdDelta: 0.0014,
      });
    }

    if (vEd !== null) {
      phaseAActions.push({
        agentId: editor.id,
        agentName: editor.name,
        roleSlug: editor.roleSlug,
        type: 'handoff.received',
        videoNumber: vEd,
        totalVideos,
        artifactTitle: `instrucao_edicao_video_${String(vEd).padStart(2, '0')}.json`,
        message: `Pegando na sua estante (Baia 2) as instruções claras de edição do Vídeo #${vEd}/${totalVideos}.`,
        tokensUsedDelta: 120,
        costUsdDelta: 0.0003,
      });
    }

    if (vPub !== null) {
      phaseAActions.push({
        agentId: publisher.id,
        agentName: publisher.name,
        roleSlug: publisher.roleSlug,
        type: 'handoff.received',
        videoNumber: vPub,
        totalVideos,
        artifactTitle: `video_short_${String(vPub).padStart(2, '0')}_9x16.mp4`,
        message: `Pegando na sua estante (Baia 3) o Vídeo #${vPub}/${totalVideos} editado para publicação.`,
        tokensUsedDelta: 100,
        costUsdDelta: 0.0002,
      });
    }

    if (phaseAActions.length > 0) {
      const [primary, ...rest] = phaseAActions;
      steps.push({
        ...primary!,
        concurrentActions: rest,
        durationMs: 2600,
      });
    }

    // FASE B DA ONDA: Todos os funcionarios ativos trabalham SIMULTANEAMENTE nos seus computadores CRT!
    const phaseBActions: MockScenarioAction[] = [];

    if (vSw !== null) {
      phaseBActions.push({
        agentId: scriptwriter.id,
        agentName: scriptwriter.name,
        roleSlug: scriptwriter.roleSlug,
        type: 'llm.thinking',
        videoNumber: vSw,
        totalVideos,
        message: `Redigindo instruções claras de corte (00:15-01:05), gancho e legenda do Vídeo #${vSw}/${totalVideos}.`,
        progress: Math.round((vSw / totalVideos) * 100),
        tokensUsedDelta: 1450,
        costUsdDelta: 0.0024,
      });
    }

    if (vEd !== null) {
      phaseBActions.push({
        agentId: editor.id,
        agentName: editor.name,
        roleSlug: editor.roleSlug,
        type: 'edit.cut',
        videoNumber: vEd,
        totalVideos,
        message: `Editando e legendando o Vídeo #${vEd}/${totalVideos} (9:16 vertical) no computador da Baia 2...`,
        progress: Math.round((vEd / totalVideos) * 100),
        tokensUsedDelta: 1850,
        costUsdDelta: 0.0052,
      });
    }

    if (vPub !== null) {
      const pubPlan = planYoutubeShortPublication({
        videoIndex: vPub,
        videoId: `yt_short_${String(vPub).padStart(2, '0')}`,
      });
      phaseBActions.push({
        agentId: publisher.id,
        agentName: publisher.name,
        roleSlug: publisher.roleSlug,
        type: 'publish.upload',
        videoNumber: vPub,
        totalVideos,
        artifactTitle: pubPlan.isWithinDailyQuota
          ? `short_${String(vPub).padStart(2, '0')}_publicado_url.json`
          : `short_${String(vPub).padStart(2, '0')}_agendamento.json`,
        message: pubPlan.isWithinDailyQuota
          ? `Publicando Vídeo #${vPub}/${totalVideos} no YouTube Shorts (Cota diária: ${pubPlan.dailyQuotaUsedVideos}/${pubPlan.dailyQuotaLimitVideos} • ${pubPlan.dailyQuotaUsedVideos * pubPlan.quotaUnitsConsumed}/${pubPlan.dailyQuotaUnitsLimit} un.)...`
          : `Cota diária atingida (${pubPlan.dailyQuotaLimitVideos}/${pubPlan.dailyQuotaLimitVideos} vídeos • 9.600/10.000 un.). Agendando Vídeo #${vPub}/${totalVideos} para ${pubPlan.scheduledForFormatted} (Dia +${pubPlan.dayOffset}, Slot ${pubPlan.slotInDay}/${pubPlan.dailyQuotaLimitVideos})...`,
        progress: Math.round((vPub / totalVideos) * 100),
        tokensUsedDelta: 920,
        costUsdDelta: 0.0011,
      });
    }

    if (phaseBActions.length > 0) {
      const [primary, ...rest] = phaseBActions;
      steps.push({
        ...primary!,
        concurrentActions: rest,
        durationMs: 2800,
      });
    }

    // FASE C DA ONDA: Entregas fisicas nas estantes dos destinatarios + Descanso de quem concluiu todos os N videos
    const phaseCActions: MockScenarioAction[] = [];

    if (vSw !== null) {
      phaseCActions.push({
        agentId: scriptwriter.id,
        agentName: scriptwriter.name,
        roleSlug: scriptwriter.roleSlug,
        type: 'handoff.sent',
        targetDeskSlot: editor.deskSlot,
        videoNumber: vSw,
        totalVideos,
        artifactTitle: `instrucao_edicao_video_${String(vSw).padStart(2, '0')}.json`,
        message: `Indo até a estante de ${editor.name} (${editor.deskSlot}) deixar as instruções do Vídeo #${vSw}/${totalVideos}.`,
        tokensUsedDelta: 0,
        costUsdDelta: 0,
      });
    } else if (wave === totalVideos + 1) {
      phaseCActions.push({
        agentId: scriptwriter.id,
        agentName: scriptwriter.name,
        roleSlug: scriptwriter.roleSlug,
        type: 'agent.idle',
        message: `Todos os ${totalVideos} roteiros foram entregues na estante do Editor! Indo descansar na copa.`,
        tokensUsedDelta: 0,
        costUsdDelta: 0,
      });
    }

    if (vEd !== null) {
      phaseCActions.push({
        agentId: editor.id,
        agentName: editor.name,
        roleSlug: editor.roleSlug,
        type: 'handoff.sent',
        targetDeskSlot: publisher.deskSlot,
        videoNumber: vEd,
        totalVideos,
        artifactTitle: `video_short_${String(vEd).padStart(2, '0')}_9x16.mp4`,
        message: `Indo até a estante de ${publisher.name} (${publisher.deskSlot}) deixar o Vídeo #${vEd}/${totalVideos} editado e legendado.`,
        tokensUsedDelta: 0,
        costUsdDelta: 0,
      });
    } else if (wave === totalVideos + 2) {
      phaseCActions.push({
        agentId: editor.id,
        agentName: editor.name,
        roleSlug: editor.roleSlug,
        type: 'agent.idle',
        message: `Todos os ${totalVideos} vídeos foram editados e entregues na estante do Publicador! Indo descansar na copa.`,
        tokensUsedDelta: 0,
        costUsdDelta: 0,
      });
    }

    if (vPub !== null) {
      const pubPlan = planYoutubeShortPublication({
        videoIndex: vPub,
        videoId: `yt_short_${String(vPub).padStart(2, '0')}`,
      });
      phaseCActions.push({
        agentId: publisher.id,
        agentName: publisher.name,
        roleSlug: publisher.roleSlug,
        type: vPub === totalVideos ? 'task.completed' : 'metrics.check',
        videoNumber: vPub,
        totalVideos,
        artifactTitle: pubPlan.isWithinDailyQuota
          ? `short_${String(vPub).padStart(2, '0')}_publicado_url.json`
          : `short_${String(vPub).padStart(2, '0')}_agendamento.json`,
        message: pubPlan.isWithinDailyQuota
          ? `Vídeo #${vPub}/${totalVideos} PUBLICADO: ${pubPlan.shortUrl} (${pubPlan.dailyQuotaUsedVideos}/${pubPlan.dailyQuotaLimitVideos} da cota diária • +${1200 + vPub * 310} views).`
          : `Vídeo #${vPub}/${totalVideos} AGENDADO: ${pubPlan.scheduledForFormatted} (Dia +${pubPlan.dayOffset} • Slot ${pubPlan.slotInDay}/${pubPlan.dailyQuotaLimitVideos} • periodicidade ${pubPlan.intervalHours}h).`,
        progress: Math.round((vPub / totalVideos) * 100),
        tokensUsedDelta: 340,
        costUsdDelta: 0.0004,
      });
    }

    if (phaseCActions.length > 0) {
      const [primary, ...rest] = phaseCActions;
      steps.push({
        ...primary!,
        concurrentActions: rest,
        durationMs: 3000,
      });
    }
  }

  // Passo final: Publicador tambem retorna ao descanso na copa apos concluir o ultimo video
  steps.push({
    agentId: publisher.id,
    agentName: publisher.name,
    roleSlug: publisher.roleSlug,
    type: 'agent.idle',
    message: `Todos os ${totalVideos} vídeos publicados e monitorados! Retornando para descansar na copa.`,
    tokensUsedDelta: 0,
    costUsdDelta: 0,
    durationMs: 2400,
  });

  return steps.map((step, idx) => ({
    ...step,
    stepIndex: idx + 1,
  }));
}
