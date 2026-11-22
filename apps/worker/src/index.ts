import { DEFAULT_OFFICE_TEMPLATE_SLUG, SUPABASE_TARGET_PROJECT_REF } from '@workoffice/shared';

export * from './tool-registry.js';
export * from './llm-adapter.js';
export * from './worker-engine.js';
export * from './supabase-repository.js';
export * from './tools/scriptwriter-tools.js';
export * from './tools/video-editor-tools.js';
export * from './tools/publisher-youtube-tools.js';

export interface WorkerHealthStatus {
  status: 'ok';
  projectRef: string;
  supportedTemplates: string[];
  timestamp: string;
}

export function getWorkerHealthStatus(): WorkerHealthStatus {
  return {
    status: 'ok',
    projectRef: SUPABASE_TARGET_PROJECT_REF,
    supportedTemplates: [DEFAULT_OFFICE_TEMPLATE_SLUG],
    timestamp: new Date().toISOString(),
  };
}
