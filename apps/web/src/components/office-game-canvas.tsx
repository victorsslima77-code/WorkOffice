'use client';

import {
  DEFAULT_OFFICE_MAP_LAYOUT,
  EVENT_VISUAL_CATALOG,
  resolveEventTargetGrid,
  type AgentEventType,
  type DeskSlot,
  type VisualOfficeAgent,
} from '@workoffice/shared';
import { useEffect, useRef, useState, type MouseEvent } from 'react';

export interface ActiveAgentVisualState {
  eventType: AgentEventType;
  message: string;
  progress?: number;
  targetDeskSlot?: DeskSlot;
  videoNumber?: number;
  totalVideos?: number;
}

export interface CanvasVisualCommand extends ActiveAgentVisualState {
  commandId: string;
  agentId: string;
}

interface OfficeGameCanvasProps {
  agents: readonly VisualOfficeAgent[];
  activeStates: Record<string, ActiveAgentVisualState>;
  visualCommandLog?: readonly CanvasVisualCommand[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onClickDesk?: (deskSlot: DeskSlot) => void;
  onClickShelf?: (deskSlot: DeskSlot) => void;
  playbackSpeed?: 1 | 2 | 4;
}

type AnimClipName =
  | 'walk_down'
  | 'walk_up'
  | 'walk_side'
  | 'sit_type'
  | 'drink_coffee_stand'
  | 'drink_coffee_sit'
  | 'stand_read'
  | 'paused';

interface Point2D {
  col: number;
  row: number;
}

interface QueuedVisualTransition {
  eventType: AgentEventType;
  targetCol: number;
  targetRow: number;
  arrivalAnim: AnimClipName;
  arrivalFlipX: boolean;
  bubbleText: string;
  bubbleBorderColor: string;
  progress?: number;
  eventKey: string;
  /** Chave de entrega fisica que esta transicao libera ao chegar na estante destino (ex: "desk_2::v1") */
  deliversToKey?: string;
  /** Estante destino onde o pacote visual sera depositado ao chegar */
  deliversToShelfSlot?: DeskSlot;
  /** Chave de entrega fisica que deve estar concluida antes deste agente iniciar a transicao */
  requiresDeliveryKey?: string;
  /** Baia do agente anterior responsavel por entregar esse item na estante */
  upstreamDeskSlot?: DeskSlot;
  /** Se verdadeiro, ao chegar na propria estante retira 1 pasta visual da estante */
  picksUpFromShelfSlot?: DeskSlot;
}

interface RuntimeAgentActor {
  agent: VisualOfficeAgent;
  slotIndex: number;
  col: number;
  row: number;
  x: number;
  y: number;
  path: Point2D[];
  anim: AnimClipName;
  flipX: boolean;
  arrivalAnim: AnimClipName;
  arrivalFlipX: boolean;
  bubbleText: string;
  bubbleBorderColor: string;
  bubbleAlpha: number;
  progress?: number;
  sheetKey: 'char_1' | 'char_2' | 'char_3';
  holdUntilMs: number;
  lastAppliedEventKey: string;
  activeTransition: QueuedVisualTransition | null;
  queue: QueuedVisualTransition[];
}

function findAStarPath(grid: number[][], start: Point2D, goal: Point2D): Point2D[] {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;

  if (start.col === goal.col && start.row === goal.row) {
    return [];
  }

  const key = (c: number, r: number) => `${c},${r}`;
  const isWalkable = (c: number, r: number) =>
    r >= 0 && r < rows && c >= 0 && c < cols && grid[r]?.[c] === 0;

  if (!isWalkable(goal.col, goal.row)) {
    return [goal];
  }

  const openSet: Point2D[] = [{ col: start.col, row: start.row }];
  const cameFrom = new Map<string, Point2D>();
  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();

  const startKey = key(start.col, start.row);
  gScore.set(startKey, 0);
  fScore.set(startKey, Math.hypot(goal.col - start.col, goal.row - start.row));

  const dirs = [
    { dc: 0, dr: -1, cost: 1 },
    { dc: 1, dr: 0, cost: 1 },
    { dc: 0, dr: 1, cost: 1 },
    { dc: -1, dr: 0, cost: 1 },
    { dc: 1, dr: -1, cost: 1.414 },
    { dc: 1, dr: 1, cost: 1.414 },
    { dc: -1, dr: 1, cost: 1.414 },
    { dc: -1, dr: -1, cost: 1.414 },
  ];

  const closedSet = new Set<string>();

  while (openSet.length > 0) {
    openSet.sort(
      (a, b) =>
        (fScore.get(key(a.col, a.row)) ?? Infinity) -
        (fScore.get(key(b.col, b.row)) ?? Infinity),
    );
    const current = openSet.shift()!;
    const currentKey = key(current.col, current.row);

    if (current.col === goal.col && current.row === goal.row) {
      const path: Point2D[] = [];
      let curr: Point2D | undefined = current;
      while (curr && !(curr.col === start.col && curr.row === start.row)) {
        path.unshift(curr);
        curr = cameFrom.get(key(curr.col, curr.row));
      }
      return path;
    }

    closedSet.add(currentKey);

    for (const d of dirs) {
      const nc = current.col + d.dc;
      const nr = current.row + d.dr;
      if (!isWalkable(nc, nr)) continue;

      if (d.dc !== 0 && d.dr !== 0) {
        if (
          !isWalkable(current.col + d.dc, current.row) ||
          !isWalkable(current.col, current.row + d.dr)
        ) {
          continue;
        }
      }

      const nKey = key(nc, nr);
      if (closedSet.has(nKey)) continue;

      const tentativeG = (gScore.get(currentKey) ?? Infinity) + d.cost;
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, current);
        gScore.set(nKey, tentativeG);
        fScore.set(nKey, tentativeG + Math.hypot(goal.col - nc, goal.row - nr));
        if (!openSet.some((p) => p.col === nc && p.row === nr)) {
          openSet.push({ col: nc, row: nr });
        }
      }
    }
  }

  return [goal];
}

function getFramesForClip(
  sheetKey: 'char_1' | 'char_2' | 'char_3',
  clip: AnimClipName,
): number[] {
  if (sheetKey === 'char_3') {
    switch (clip) {
      case 'walk_down':
        return [0, 1, 2, 3];
      case 'walk_up':
        return [4, 5, 6, 7];
      case 'walk_side':
        return [8, 9, 10, 11];
      case 'sit_type':
        return [16, 17, 18, 19];
      case 'drink_coffee_stand':
        return [24, 25, 26, 27];
      case 'drink_coffee_sit':
        return [28, 29, 30, 31];
      case 'stand_read':
        return [4];
      case 'paused':
        return [28];
    }
  }

  switch (clip) {
    case 'walk_down':
      return [0, 1, 2, 3];
    case 'walk_up':
      return [4, 5, 6, 7];
    case 'walk_side':
      return [8, 9, 10, 11];
    case 'sit_type':
      return [12, 13, 14, 15];
    case 'drink_coffee_stand':
      return [16, 17, 18, 19];
    case 'drink_coffee_sit':
      return [20, 21, 22, 23];
    case 'stand_read':
      return [4];
    case 'paused':
      return [20];
  }
}

export default function OfficeGameCanvas({
  agents,
  activeStates,
  visualCommandLog,
  selectedAgentId,
  onSelectAgent,
  onClickDesk,
  onClickShelf,
  playbackSpeed = 1,
}: OfficeGameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const actorsRef = useRef<Map<string, RuntimeAgentActor>>(new Map());
  const deliveredShelfKeysRef = useRef<Set<string>>(new Set());
  const shelfFolderCountRef = useRef<Record<DeskSlot, number>>({
    desk_1: 0,
    desk_2: 0,
    desk_3: 0,
  });
  const processedCommandIdsRef = useRef<Set<string>>(new Set());
  const imagesRef = useRef<{
    office: HTMLImageElement | null;
    char_1: HTMLImageElement | null;
    char_2: HTMLImageElement | null;
    char_3: HTMLImageElement | null;
  }>({
    office: null,
    char_1: null,
    char_2: null,
    char_3: null,
  });

  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const dragRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
  }>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    origPanX: 0,
    origPanY: 0,
  });

  const zoomRef = useRef(zoomLevel);
  zoomRef.current = zoomLevel;
  const panRef = useRef(pan);
  panRef.current = pan;
  const selectedIdRef = useRef(selectedAgentId);
  selectedIdRef.current = selectedAgentId;
  const speedRef = useRef(playbackSpeed);
  speedRef.current = playbackSpeed;

  useEffect(() => {
    const createImg = (src: string) => {
      const img = new Image();
      img.src = src;
      return img;
    };

    imagesRef.current = {
      office: createImg('/assets/office.png'),
      char_1: createImg('/assets/character-1-sprites.png'),
      char_2: createImg('/assets/character-2-sprites.png'),
      char_3: createImg('/assets/character-3-sprites.png'),
    };
  }, []);

  // Zoom com scroll do mouse (wheel) dentro da area do canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = canvas.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const sy = ((e.clientY - rect.top) / rect.height) * canvas.height;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      const prevZoom = zoomRef.current;
      const delta = e.deltaY < 0 ? 0.25 : -0.25;
      const nextZoom = Number(Math.min(3.5, Math.max(0.75, prevZoom + delta)).toFixed(2));
      if (nextZoom === prevZoom) return;

      const prevPan = panRef.current;
      const wx = (sx - cx - prevPan.x) / prevZoom + cx;
      const wy = (sy - cy - prevPan.y) / prevZoom + cy;

      const nextPanX = sx - cx - (wx - cx) * nextZoom;
      const nextPanY = sy - cy - (wy - cy) * nextZoom;

      setZoomLevel(nextZoom);
      setPan({ x: nextPanX, y: nextPanY });
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, []);

  useEffect(() => {
    const layout = DEFAULT_OFFICE_MAP_LAYOUT;
    const map = new Map<string, RuntimeAgentActor>();

    agents.forEach((ag, idx) => {
      const startSpot = resolveEventTargetGrid('agent.idle', ag.deskSlot, idx, layout);
      const startX = startSpot.col * layout.tileWidth + layout.tileWidth / 2;
      const startY = startSpot.row * layout.tileHeight + layout.tileHeight / 2;
      const sheetKey: 'char_1' | 'char_2' | 'char_3' =
        ag.spriteKey === 'character_1'
          ? 'char_1'
          : ag.spriteKey === 'character_3'
            ? 'char_3'
            : 'char_2';

      const coffeeClip: AnimClipName = 'drink_coffee_stand';

      map.set(ag.id, {
        agent: ag,
        slotIndex: idx,
        col: startSpot.col,
        row: startSpot.row,
        x: startX,
        y: startY,
        path: [],
        anim: coffeeClip,
        flipX: false,
        arrivalAnim: coffeeClip,
        arrivalFlipX: false,
        bubbleText: '☕ idle',
        bubbleBorderColor: '#f59e0b',
        bubbleAlpha: 1,
        sheetKey,
        holdUntilMs: 0,
        lastAppliedEventKey: 'agent.idle::init',
        activeTransition: null,
        queue: [],
      });
    });

    actorsRef.current = map;
    deliveredShelfKeysRef.current.clear();
    shelfFolderCountRef.current = { desk_1: 0, desk_2: 0, desk_3: 0 };
    processedCommandIdsRef.current.clear();
  }, [agents]);

  function enqueueActorVisualState(
    actor: RuntimeAgentActor,
    st: ActiveAgentVisualState,
    explicitEventKey?: string,
  ) {
    const layout = DEFAULT_OFFICE_MAP_LAYOUT;
    const eventKey =
      explicitEventKey ??
      `${st.eventType}::${st.message}::${st.progress ?? ''}::${st.videoNumber ?? ''}`;

    if (
      actor.lastAppliedEventKey === eventKey ||
      actor.queue.some((q) => q.eventKey === eventKey)
    ) {
      return;
    }

    const mapping = EVENT_VISUAL_CATALOG[st.eventType];
    const target = resolveEventTargetGrid(
      st.eventType,
      actor.agent.deskSlot,
      actor.slotIndex,
      layout,
      st.targetDeskSlot,
    );

    const shortAction =
      st.eventType === 'handoff.sent'
        ? 'entregar estante'
        : st.eventType === 'handoff.received'
          ? 'pegar estante'
          : (st.eventType.split('.')[1] ?? st.eventType);
    const videoBadge =
      typeof st.videoNumber === 'number' && typeof st.totalVideos === 'number'
        ? ` #${st.videoNumber}/${st.totalVideos}`
        : '';
    const bubbleText = `${mapping.bubbleIcon} ${shortAction}${videoBadge}`;
    const bubbleBorderColor =
      st.eventType === 'task.failed'
        ? '#ef4444'
        : st.eventType === 'task.completed'
          ? '#10b981'
          : '#f59e0b';

    let arrivalAnim: AnimClipName = 'paused';
    let arrivalFlipX = false;

    if (mapping.animationKey === 'sit_type') {
      arrivalAnim = 'sit_type';
      arrivalFlipX = actor.sheetKey !== 'char_3';
    } else if (mapping.animationKey === 'stand_read') {
      arrivalAnim = 'stand_read';
      arrivalFlipX = false;
    } else if (mapping.animationKey === 'drink_coffee') {
      arrivalAnim = 'drink_coffee_stand';
      arrivalFlipX = false;
    } else if (mapping.animationKey === 'carry_folder') {
      arrivalAnim = 'stand_read';
      arrivalFlipX = false;
    }

    // Interrupcao imediata ou reset limpa a fila de animacao do agente
    if (st.eventType === 'agent.idle' && st.message.toLowerCase().includes('interromp')) {
      actor.queue = [];
      actor.path = [];
      actor.activeTransition = null;
      actor.holdUntilMs = 0;
    }

    // Mapeia dependencia fisica de entrega nas estantes:
    // - desk_1 (Roteirista) -> entrega em desk_2 (Editor)
    // - desk_2 (Editor) -> entrega em desk_3 (Publicador)
    const videoNum = typeof st.videoNumber === 'number' ? st.videoNumber : 1;
    let deliversToKey: string | undefined;
    let deliversToShelfSlot: DeskSlot | undefined;
    let requiresDeliveryKey: string | undefined;
    let upstreamDeskSlot: DeskSlot | undefined;
    let picksUpFromShelfSlot: DeskSlot | undefined;

    if (st.eventType === 'handoff.sent') {
      const destSlot: DeskSlot =
        st.targetDeskSlot ?? (actor.agent.deskSlot === 'desk_1' ? 'desk_2' : 'desk_3');
      deliversToShelfSlot = destSlot;
      deliversToKey = `${destSlot}::v${videoNum}`;
    }

    const isDownstreamWorkEvent =
      (actor.agent.deskSlot === 'desk_2' || actor.agent.deskSlot === 'desk_3') &&
      st.eventType !== 'agent.idle' &&
      st.eventType !== 'budget.exceeded';

    if (isDownstreamWorkEvent) {
      upstreamDeskSlot = actor.agent.deskSlot === 'desk_2' ? 'desk_1' : 'desk_2';
      requiresDeliveryKey = `${actor.agent.deskSlot}::v${videoNum}`;
    }

    if (st.eventType === 'handoff.received') {
      picksUpFromShelfSlot = actor.agent.deskSlot;
    }

    actor.queue.push({
      eventType: st.eventType,
      targetCol: target.col,
      targetRow: target.row,
      arrivalAnim,
      arrivalFlipX,
      bubbleText,
      bubbleBorderColor,
      progress: st.progress,
      eventKey,
      deliversToKey,
      deliversToShelfSlot,
      requiresDeliveryKey,
      upstreamDeskSlot,
      picksUpFromShelfSlot,
    });
  }

  // Consome log ordenado de comandos visuais (evita perda de passos intermediarios como handoff.sent)
  useEffect(() => {
    if (!visualCommandLog) return;
    if (visualCommandLog.length === 0) {
      deliveredShelfKeysRef.current.clear();
      shelfFolderCountRef.current = { desk_1: 0, desk_2: 0, desk_3: 0 };
      processedCommandIdsRef.current.clear();
      actorsRef.current.forEach((actor) => {
        actor.queue = [];
        actor.activeTransition = null;
        actor.holdUntilMs = 0;
      });
      return;
    }

    for (const cmd of visualCommandLog) {
      if (processedCommandIdsRef.current.has(cmd.commandId)) continue;
      processedCommandIdsRef.current.add(cmd.commandId);
      const actor = actorsRef.current.get(cmd.agentId);
      if (!actor) continue;
      enqueueActorVisualState(actor, cmd, cmd.commandId);
    }
  }, [visualCommandLog]);

  useEffect(() => {
    if (visualCommandLog && visualCommandLog.length > 0) {
      return;
    }
    Object.entries(activeStates).forEach(([agentId, st]) => {
      const actor = actorsRef.current.get(agentId);
      if (!actor) return;
      enqueueActorVisualState(actor, st);
    });
  }, [activeStates, visualCommandLog]);

  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();
    const layout = DEFAULT_OFFICE_MAP_LAYOUT;

    const renderLoop = (now: number) => {
      const dt = Math.min(0.08, (now - lastTime) / 1000);
      lastTime = now;

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        ctx.imageSmoothingEnabled = false;

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.save();
        const z = zoomRef.current;
        const p = panRef.current;
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        ctx.translate(cx + p.x, cy + p.y);
        ctx.scale(z, z);
        ctx.translate(-cx, -cy);

        const officeImg = imagesRef.current.office;
        if (officeImg && officeImg.complete && officeImg.naturalWidth > 0) {
          ctx.drawImage(officeImg, 0, 0, layout.imageWidth, layout.imageHeight);
        }

        // Desenha indicadores clicaveis sutis sobre as Estantes (📚) e Mesas/Computadores CRT (💻) de cada sala
        const baySlots: DeskSlot[] = ['desk_1', 'desk_2', 'desk_3'];
        for (const slot of baySlots) {
          const spot = layout.hotspots[slot];
          const shelfX = spot.shelf.col * layout.tileWidth + layout.tileWidth / 2;
          const shelfY = spot.shelf.row * layout.tileHeight - 18;
          const deskX = (spot.chair.col + 1) * layout.tileWidth + layout.tileWidth / 2;
          const deskY = spot.chair.row * layout.tileHeight - 24;
          const bayNum = slot.replace('desk_', '');

          // Badge clicavel da Estante (Caixa de Entrada/Saida) + indicador de pastas fisicas aguardando retirada
          const pendingFolders = shelfFolderCountRef.current[slot] ?? 0;
          ctx.save();
          ctx.fillStyle = pendingFolders > 0 ? 'rgba(120, 53, 15, 0.94)' : 'rgba(15, 23, 42, 0.86)';
          ctx.fillRect(shelfX - 42, shelfY - 9, 84, 17);
          ctx.strokeStyle = pendingFolders > 0 ? '#fbbf24' : 'rgba(245, 158, 11, 0.85)';
          ctx.lineWidth = pendingFolders > 0 ? 1.8 : 1.2;
          ctx.strokeRect(shelfX - 42, shelfY - 9, 84, 17);
          ctx.fillStyle = '#fde68a';
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            pendingFolders > 0 ? `📄 Estante B${bayNum} (${pendingFolders})` : `📚 Estante B${bayNum}`,
            shelfX,
            shelfY,
          );
          ctx.restore();

          // Badge clicavel da Mesa / Computador CRT (Ferramentas & Contexto)
          ctx.save();
          ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
          ctx.fillRect(deskX - 36, deskY - 9, 72, 17);
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.85)';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(deskX - 36, deskY - 9, 72, 17);
          ctx.fillStyle = '#6ee7b7';
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`💻 Mesa B${bayNum}`, deskX, deskY);
          ctx.restore();
        }

        const moveSpeedPxPerSec = 128 * speedRef.current;
        const sortedActors = Array.from(actorsRef.current.values());

        const completeArrivalSideEffects = (actor: RuntimeAgentActor) => {
          const done = actor.activeTransition;
          if (!done) return;
          if (done.deliversToKey) {
            deliveredShelfKeysRef.current.add(done.deliversToKey);
            if (done.deliversToShelfSlot) {
              shelfFolderCountRef.current[done.deliversToShelfSlot] =
                (shelfFolderCountRef.current[done.deliversToShelfSlot] ?? 0) + 1;
            }
          }
          if (done.picksUpFromShelfSlot) {
            shelfFolderCountRef.current[done.picksUpFromShelfSlot] = Math.max(
              0,
              (shelfFolderCountRef.current[done.picksUpFromShelfSlot] ?? 0) - 1,
            );
          }
          actor.activeTransition = null;
        };

        for (const actor of sortedActors) {
          // Conclui efeitos fisicos de entrega/retirada na estante assim que o agente termina o gesto na estante
          if (actor.path.length === 0 && now >= actor.holdUntilMs && actor.activeTransition) {
            completeArrivalSideEffects(actor);
          }

          if (actor.path.length === 0 && now >= actor.holdUntilMs && actor.queue.length > 0) {
            const peek = actor.queue[0]!;

            // BARREIRA DE IMERSAO: Mesmo que o backend/IA ja tenha processado a proxima etapa,
            // o funcionario destinatario AGUARDA o agente anterior chegar fisicamente a estante e entregar a pasta!
            if (
              peek.requiresDeliveryKey &&
              !deliveredShelfKeysRef.current.has(peek.requiresDeliveryKey) &&
              peek.upstreamDeskSlot
            ) {
              const upstreamActor = sortedActors.find(
                (a) => a.agent.deskSlot === peek.upstreamDeskSlot,
              );
              const upstreamHasPendingDelivery =
                upstreamActor &&
                (upstreamActor.path.length > 0 ||
                  upstreamActor.queue.length > 0 ||
                  upstreamActor.activeTransition?.deliversToKey === peek.requiresDeliveryKey ||
                  now < upstreamActor.holdUntilMs);

              if (upstreamHasPendingDelivery) {
                continue;
              }
            }

            const nextTransition = actor.queue.shift()!;
            actor.activeTransition = nextTransition;
            actor.lastAppliedEventKey = nextTransition.eventKey;
            actor.arrivalAnim = nextTransition.arrivalAnim;
            actor.arrivalFlipX = nextTransition.arrivalFlipX;
            actor.bubbleText = nextTransition.bubbleText;
            actor.bubbleBorderColor = nextTransition.bubbleBorderColor;
            actor.progress = nextTransition.progress;
            actor.bubbleAlpha = 0.25;

            const currentCol = Math.round((actor.x - layout.tileWidth / 2) / layout.tileWidth);
            const currentRow = Math.round((actor.y - layout.tileHeight / 2) / layout.tileHeight);
            actor.col = currentCol;
            actor.row = currentRow;

            if (
              currentCol === nextTransition.targetCol &&
              currentRow === nextTransition.targetRow
            ) {
              actor.path = [];
              actor.anim = actor.arrivalAnim;
              actor.flipX = actor.arrivalFlipX;
              actor.holdUntilMs = now + Math.round(750 / speedRef.current);
            } else {
              actor.path = findAStarPath(
                layout.grid,
                { col: currentCol, row: currentRow },
                { col: nextTransition.targetCol, row: nextTransition.targetRow },
              );
            }
          }

          if (actor.bubbleAlpha < 1) {
            actor.bubbleAlpha = Math.min(1, actor.bubbleAlpha + dt * 3.2);
          }

          const nextWaypoint = actor.path[0];
          if (nextWaypoint) {
            const targetX = nextWaypoint.col * layout.tileWidth + layout.tileWidth / 2;
            const targetY = nextWaypoint.row * layout.tileHeight + layout.tileHeight / 2;
            const dx = targetX - actor.x;
            const dy = targetY - actor.y;
            const dist = Math.hypot(dx, dy);

            if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > 1) {
              actor.anim = 'walk_side';
              actor.flipX = actor.sheetKey === 'char_3' ? dx < 0 : dx > 0;
            } else if (dy < -1) {
              actor.anim = 'walk_up';
              actor.flipX = false;
            } else if (dy > 1) {
              actor.anim = 'walk_down';
              actor.flipX = false;
            }

            const isFinalTile = actor.path.length === 1;
            const damping = isFinalTile && dist < 16 ? Math.max(0.55, dist / 16) : 1;
            const step = moveSpeedPxPerSec * damping * dt;

            if (dist <= step) {
              actor.x = targetX;
              actor.y = targetY;
              actor.col = nextWaypoint.col;
              actor.row = nextWaypoint.row;
              actor.path.shift();
              if (actor.path.length === 0) {
                actor.anim = actor.arrivalAnim;
                actor.flipX = actor.arrivalFlipX;
                const holdDuration =
                  actor.activeTransition?.eventType === 'handoff.sent' ? 750 : 1050;
                actor.holdUntilMs = now + Math.round(holdDuration / speedRef.current);
              }
            } else {
              actor.x += (dx / dist) * step;
              actor.y += (dy / dist) * step;
            }
          }
        }

        sortedActors.sort((a, b) => a.y - b.y);

        const walkFrameTick = Math.floor(now / 280);
        const idleOrWorkFrameTick = Math.floor(now / 440);

        for (const actor of sortedActors) {
          const isSelected = actor.agent.id === selectedIdRef.current;
          const isWalking = actor.path.length > 0;

          if (isSelected) {
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(actor.x, actor.y - 2, 24, 10, 0, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(245, 158, 11, 0.35)';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#f59e0b';
            ctx.stroke();
            ctx.restore();
          }

          const sheetImg = imagesRef.current[actor.sheetKey];
          if (sheetImg && sheetImg.complete && sheetImg.naturalWidth > 0) {
            const frames = getFramesForClip(actor.sheetKey, actor.anim);
            const activeTick = isWalking ? walkFrameTick : idleOrWorkFrameTick;
            const frameIndex =
              frames[(activeTick + actor.slotIndex) % frames.length] ?? 0;
            const cols = 8;
            const frameW = 172;
            const frameH = actor.sheetKey === 'char_3' ? 192 : 256;
            const sx = (frameIndex % cols) * frameW;
            const sy = Math.floor(frameIndex / cols) * frameH;

            const scale = actor.sheetKey === 'char_3' ? 0.56 : 0.45;
            const dw = Math.round(frameW * scale);
            const dh = Math.round(frameH * scale);

            ctx.save();
            ctx.translate(Math.round(actor.x), Math.round(actor.y));
            if (actor.flipX) {
              ctx.scale(-1, 1);
            }
            ctx.drawImage(
              sheetImg,
              sx,
              sy,
              frameW,
              frameH,
              Math.round(-dw / 2),
              Math.round(-dh * 0.86),
              dw,
              dh,
            );
            ctx.restore();
          }

          const label = actor.agent.name.slice(0, 18);
          ctx.save();
          ctx.font = 'bold 10px monospace';
          const textW = Math.max(76, ctx.measureText(label).width + 14);
          const tagX = Math.round(actor.x - textW / 2);
          const tagY = Math.round(actor.y + 4);
          ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
          ctx.fillRect(tagX, tagY, textW, 16);
          ctx.strokeStyle = isSelected ? '#f59e0b' : '#475569';
          ctx.lineWidth = 1;
          ctx.strokeRect(tagX, tagY, textW, 16);
          ctx.fillStyle = '#f8fafc';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, Math.round(actor.x), tagY + 8);
          ctx.restore();

          ctx.save();
          ctx.globalAlpha = actor.bubbleAlpha;
          ctx.font = 'bold 11px monospace';
          const bubbleW = Math.max(96, ctx.measureText(actor.bubbleText).width + 18);
          const bubbleH = typeof actor.progress === 'number' ? 28 : 22;
          const bx = Math.round(actor.x - bubbleW / 2);
          const by = Math.round(actor.y - 108);

          ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
          ctx.fillRect(bx, by, bubbleW, bubbleH);
          ctx.strokeStyle = actor.bubbleBorderColor;
          ctx.lineWidth = 2;
          ctx.strokeRect(bx, by, bubbleW, bubbleH);

          ctx.fillStyle = '#fde68a';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(actor.bubbleText, Math.round(actor.x), by + 11);

          if (typeof actor.progress === 'number') {
            const barW = bubbleW - 12;
            const barX = bx + 6;
            const barY = by + 21;
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(barX, barY, barW, 3);
            ctx.fillStyle = '#10b981';
            ctx.fillRect(
              barX,
              barY,
              Math.round((barW * Math.min(100, Math.max(0, actor.progress))) / 100),
              3,
            );
          }
          ctx.restore();
        }

        ctx.restore();
      }

      rafId = requestAnimationFrame(renderLoop);
    };

    rafId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  function screenToWorld(clientX: number, clientY: number): { wx: number; wy: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = ((clientX - rect.left) / rect.width) * canvas.width;
    const sy = ((clientY - rect.top) / rect.height) * canvas.height;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const wx = (sx - cx - pan.x) / zoomLevel + cx;
    const wy = (sy - cy - pan.y) / zoomLevel + cy;
    return { wx, wy };
  }

  function handleMouseDown(e: MouseEvent<HTMLCanvasElement>) {
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      origPanX: pan.x,
      origPanY: pan.y,
    };
  }

  function handleMouseMove(e: MouseEvent<HTMLCanvasElement>) {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.hypot(dx, dy) > 4) {
      dragRef.current.moved = true;
    }
    setPan({
      x: dragRef.current.origPanX + dx,
      y: dragRef.current.origPanY + dy,
    });
  }

  function handleMouseUp(e: MouseEvent<HTMLCanvasElement>) {
    const wasMoved = dragRef.current.moved;
    dragRef.current.active = false;

    if (!wasMoved) {
      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;

      const layout = DEFAULT_OFFICE_MAP_LAYOUT;
      const baySlots: DeskSlot[] = ['desk_1', 'desk_2', 'desk_3'];

      // 1. Verifica clique na Estante de cada sala (abre modal de Caixa de Entrada e Caixa de Saida)
      for (const slot of baySlots) {
        const spot = layout.hotspots[slot];
        const shelfX = spot.shelf.col * layout.tileWidth + layout.tileWidth / 2;
        const shelfY = spot.shelf.row * layout.tileHeight;
        if (Math.abs(world.wx - shelfX) <= 56 && world.wy >= shelfY - 48 && world.wy <= shelfY + 36) {
          const ag = agents.find((a) => a.deskSlot === slot);
          if (ag) onSelectAgent(ag.id);
          onClickShelf?.(slot);
          return;
        }
      }

      // 2. Verifica clique na Mesa / Computador CRT de cada sala (abre modal de Ferramentas e Instrucoes de Contexto)
      for (const slot of baySlots) {
        const spot = layout.hotspots[slot];
        const deskX = (spot.chair.col + 1) * layout.tileWidth + layout.tileWidth / 2;
        const deskY = spot.chair.row * layout.tileHeight;
        if (Math.abs(world.wx - deskX) <= 64 && world.wy >= deskY - 52 && world.wy <= deskY + 42) {
          const ag = agents.find((a) => a.deskSlot === slot);
          if (ag) onSelectAgent(ag.id);
          onClickDesk?.(slot);
          return;
        }
      }

      // 3. Verifica clique sobre o personagem em qualquer lugar do escritorio
      const actors = Array.from(actorsRef.current.values()).sort((a, b) => b.y - a.y);
      for (const actor of actors) {
        const withinX = Math.abs(world.wx - actor.x) <= 38;
        const withinY = world.wy >= actor.y - 105 && world.wy <= actor.y + 22;
        if (withinX && withinY) {
          onSelectAgent(actor.agent.id);
          break;
        }
      }
    }
  }

  function handleResetCamera() {
    setZoomLevel(1);
    setPan({ x: 0, y: 0 });
  }

  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden border-2 border-amber-500/80 bg-black">
      {/* Único ícone flutuante para recentralizar a câmera */}
      <button
        type="button"
        onClick={handleResetCamera}
        title="Recentralizar câmera (Reset Zoom & Pan)"
        aria-label="Recentralizar câmera"
        className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center border-2 border-slate-700 bg-slate-900/90 text-base text-amber-400 shadow transition hover:border-amber-400 hover:bg-slate-800"
      >
        ⌖
      </button>

      <canvas
        ref={canvasRef}
        width={1376}
        height={768}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          dragRef.current.active = false;
        }}
        className="block h-full w-full cursor-grab select-none active:cursor-grabbing"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
}
