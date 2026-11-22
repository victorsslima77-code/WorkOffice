import { z } from 'zod';

export const AgentEventTypeSchema = z.enum([
  'agent.idle',
  'task.started',
  'research.web_search',
  'research.read_source',
  'llm.thinking',
  'edit.download',
  'edit.cut',
  'edit.subtitle',
  'edit.render',
  'handoff.sent',
  'handoff.received',
  'publish.upload',
  'metrics.check',
  'task.completed',
  'task.failed',
  'budget.exceeded',
]);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const AgentEventPayloadSchema = z
  .object({
    message: z.string().optional(),
    progress: z.number().min(0).max(100).optional(),
    toolName: z.string().optional(),
    targetAgentId: z.string().uuid().optional(),
    targetRoleSlug: z.string().optional(),
    sourceUrl: z.string().optional(),
    errorCode: z.string().optional(),
  })
  .passthrough();
export type AgentEventPayload = z.infer<typeof AgentEventPayloadSchema>;

export const AgentEventRecordSchema = z.object({
  id: z.number().int().nonnegative(),
  office_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  task_id: z.string().uuid().nullable(),
  type: AgentEventTypeSchema,
  payload: AgentEventPayloadSchema,
  created_at: z.string(),
});
export type AgentEventRecord = z.infer<typeof AgentEventRecordSchema>;

export interface VisualBehaviorMapping {
  type: AgentEventType;
  targetHotspot: 'own_desk' | 'own_shelf' | 'target_shelf' | 'meeting_table' | 'lounge';
  animationKey: 'walk' | 'sit_type' | 'stand_read' | 'drink_coffee' | 'carry_folder' | 'paused';
  bubbleIcon: string;
}

export const EVENT_VISUAL_CATALOG: Record<AgentEventType, VisualBehaviorMapping> = {
  'agent.idle': {
    type: 'agent.idle',
    targetHotspot: 'lounge',
    animationKey: 'drink_coffee',
    bubbleIcon: '☕',
  },
  'task.started': {
    type: 'task.started',
    targetHotspot: 'own_desk',
    animationKey: 'sit_type',
    bubbleIcon: '▶️',
  },
  'research.web_search': {
    type: 'research.web_search',
    targetHotspot: 'own_desk',
    animationKey: 'sit_type',
    bubbleIcon: '🔎',
  },
  'research.read_source': {
    type: 'research.read_source',
    targetHotspot: 'own_shelf',
    animationKey: 'stand_read',
    bubbleIcon: '📖',
  },
  'llm.thinking': {
    type: 'llm.thinking',
    targetHotspot: 'own_desk',
    animationKey: 'sit_type',
    bubbleIcon: '...',
  },
  'edit.download': {
    type: 'edit.download',
    targetHotspot: 'own_desk',
    animationKey: 'sit_type',
    bubbleIcon: '⬇️',
  },
  'edit.cut': {
    type: 'edit.cut',
    targetHotspot: 'own_desk',
    animationKey: 'sit_type',
    bubbleIcon: '✂️',
  },
  'edit.subtitle': {
    type: 'edit.subtitle',
    targetHotspot: 'own_desk',
    animationKey: 'sit_type',
    bubbleIcon: '💬',
  },
  'edit.render': {
    type: 'edit.render',
    targetHotspot: 'own_desk',
    animationKey: 'sit_type',
    bubbleIcon: '🎬',
  },
  'handoff.sent': {
    type: 'handoff.sent',
    targetHotspot: 'target_shelf',
    animationKey: 'stand_read',
    bubbleIcon: '📄',
  },
  'handoff.received': {
    type: 'handoff.received',
    targetHotspot: 'own_shelf',
    animationKey: 'stand_read',
    bubbleIcon: '📥',
  },
  'publish.upload': {
    type: 'publish.upload',
    targetHotspot: 'own_desk',
    animationKey: 'sit_type',
    bubbleIcon: '⬆️',
  },
  'metrics.check': {
    type: 'metrics.check',
    targetHotspot: 'own_desk',
    animationKey: 'sit_type',
    bubbleIcon: '📈',
  },
  'task.completed': {
    type: 'task.completed',
    targetHotspot: 'own_desk',
    animationKey: 'sit_type',
    bubbleIcon: '✅',
  },
  'task.failed': {
    type: 'task.failed',
    targetHotspot: 'own_desk',
    animationKey: 'paused',
    bubbleIcon: '❗',
  },
  'budget.exceeded': {
    type: 'budget.exceeded',
    targetHotspot: 'lounge',
    animationKey: 'paused',
    bubbleIcon: '💤',
  },
};
