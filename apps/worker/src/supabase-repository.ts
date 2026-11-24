import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AgentEventType,
  DeskSlot,
  EffortLevel,
  LlmProvider,
  RoleSlug,
} from '@workoffice/shared';
import {
  processQueuedAgentTask,
  type WorkerAgentRecord,
  type WorkerRepository,
  type WorkerTaskRecord,
} from './worker-engine.js';
import type { YoutubeOAuthCredentials } from './tools/publisher-youtube-tools.js';

export class SupabaseWorkerRepository implements WorkerRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  getStorageClient(): SupabaseClient {
    return this.supabase;
  }

  async getOfficeYoutubeOAuth(officeId: string): Promise<YoutubeOAuthCredentials | null> {
    const { data, error } = await this.supabase.rpc('get_office_youtube_secret_for_worker', {
      p_office_id: officeId,
    });

    if (error || !data) {
      return null;
    }

    const raw = data as {
      channel_id?: string;
      client_id?: string;
      client_secret?: string;
      refresh_token?: string;
      metadata?: Record<string, unknown>;
    };

    if (!raw.refresh_token) {
      return null;
    }

    return {
      channelId: raw.channel_id ?? 'UC_channel',
      clientId: raw.client_id ?? '',
      clientSecret: raw.client_secret ?? '',
      refreshToken: raw.refresh_token,
      metadata: raw.metadata ?? {},
    };
  }

  async getTaskById(taskId: string): Promise<WorkerTaskRecord | null> {
    const { data, error } = await this.supabase
      .from('tasks')
      .select('id, run_id, agent_id, role_id, input, status, attempts')
      .eq('id', taskId)
      .maybeSingle();

    if (error || !data) return null;
    return data as unknown as WorkerTaskRecord;
  }

  async getRunStatus(
    runId: string,
  ): Promise<'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | null> {
    const { data } = await this.supabase
      .from('runs')
      .select('status')
      .eq('id', runId)
      .maybeSingle();

    return (data?.status as 'queued' | 'running' | 'completed' | 'failed' | 'cancelled') ?? null;
  }

  async getAgentWithRole(agentId: string): Promise<WorkerAgentRecord | null> {
    const { data, error } = await this.supabase
      .from('agents')
      .select(
        'id, office_id, role_id, name, desk_slot, provider, model, effort, monthly_token_budget, status, roles(slug, allowed_tools, system_prompt)',
      )
      .eq('id', agentId)
      .maybeSingle();

    if (error || !data) return null;
    const roleObj = Array.isArray(data.roles) ? data.roles[0] : data.roles;

    return {
      id: data.id as string,
      office_id: data.office_id as string,
      role_id: data.role_id as string,
      name: data.name as string,
      desk_slot: data.desk_slot as DeskSlot,
      provider: data.provider as LlmProvider,
      model: data.model as string,
      effort: data.effort as EffortLevel,
      monthly_token_budget: (data.monthly_token_budget as number | null) ?? null,
      status: data.status as WorkerAgentRecord['status'],
      role_slug: (roleObj?.slug as RoleSlug) ?? 'scriptwriter',
      allowed_tools: (roleObj?.allowed_tools as string[]) ?? [],
      system_prompt: (roleObj?.system_prompt as string) ?? '',
    };
  }

  async getAgentByOfficeAndRoleSlug(
    officeId: string,
    roleSlug: RoleSlug,
  ): Promise<WorkerAgentRecord | null> {
    const { data } = await this.supabase
      .from('agents')
      .select(
        'id, office_id, role_id, name, desk_slot, provider, model, effort, monthly_token_budget, status, roles!inner(slug, allowed_tools, system_prompt)',
      )
      .eq('office_id', officeId)
      .eq('roles.slug', roleSlug)
      .maybeSingle();

    if (!data) return null;
    const roleObj = Array.isArray(data.roles) ? data.roles[0] : data.roles;

    return {
      id: data.id as string,
      office_id: data.office_id as string,
      role_id: data.role_id as string,
      name: data.name as string,
      desk_slot: data.desk_slot as DeskSlot,
      provider: data.provider as LlmProvider,
      model: data.model as string,
      effort: data.effort as EffortLevel,
      monthly_token_budget: (data.monthly_token_budget as number | null) ?? null,
      status: data.status as WorkerAgentRecord['status'],
      role_slug: (roleObj?.slug as RoleSlug) ?? roleSlug,
      allowed_tools: (roleObj?.allowed_tools as string[]) ?? [],
      system_prompt: (roleObj?.system_prompt as string) ?? '',
    };
  }

  async getNextRoleSlugsFromWorkflow(
    officeId: string,
    currentRoleSlug: RoleSlug,
  ): Promise<RoleSlug[]> {
    const { data: office } = await this.supabase
      .from('offices')
      .select('template_id')
      .eq('id', officeId)
      .maybeSingle();

    if (!office?.template_id) return [];

    const { data: wf } = await this.supabase
      .from('workflow_definitions')
      .select('steps')
      .eq('template_id', office.template_id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const steps = (wf?.steps as { role_slug: RoleSlug; next_role_slugs?: RoleSlug[] }[]) ?? [];
    const currentStep = steps.find((s) => s.role_slug === currentRoleSlug);
    return currentStep?.next_role_slugs ?? [];
  }

  async getAgentMonthlyTokensUsed(agentId: string): Promise<number> {
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

    const { data } = await this.supabase
      .from('llm_calls')
      .select('input_tokens, output_tokens, reasoning_tokens')
      .eq('agent_id', agentId)
      .gte('created_at', startOfMonth.toISOString());

    if (!data) return 0;
    return data.reduce(
      (acc, row) =>
        acc +
        Number(row.input_tokens ?? 0) +
        Number(row.output_tokens ?? 0) +
        Number(row.reasoning_tokens ?? 0),
      0,
    );
  }

  async getDecryptedSecretForAgent(agentId: string): Promise<string> {
    const { data, error } = await this.supabase.rpc('get_agent_secret_for_worker', {
      p_agent_id: agentId,
    });

    if (error || !data) {
      throw new Error(error?.message ?? `Nao foi possivel descriptografar chave para ${agentId}`);
    }

    return String(data);
  }

  async updateTaskStatus(
    taskId: string,
    patch: {
      status: WorkerTaskRecord['status'];
      attempts?: number;
      output?: unknown;
      error_message?: string | null;
      started_at?: string;
      finished_at?: string;
    },
  ): Promise<void> {
    await this.supabase.from('tasks').update(patch).eq('id', taskId);
  }

  async updateAgentStatus(agentId: string, status: WorkerAgentRecord['status']): Promise<void> {
    await this.supabase.from('agents').update({ status }).eq('id', agentId);
  }

  async updateRunTotalsAndStatus(
    runId: string,
    deltaTokens: number,
    deltaCostUsd: number,
    nextStatus?: 'running' | 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const { data: current } = await this.supabase
      .from('runs')
      .select('total_tokens, total_cost_usd, status')
      .eq('id', runId)
      .maybeSingle();

    if (!current) return;

    const patch: Record<string, unknown> = {
      total_tokens: Number(current.total_tokens ?? 0) + deltaTokens,
      total_cost_usd: Number((Number(current.total_cost_usd ?? 0) + deltaCostUsd).toFixed(6)),
    };

    if (nextStatus && current.status !== 'cancelled') {
      patch.status = nextStatus;
      if (nextStatus === 'completed' || nextStatus === 'failed') {
        patch.finished_at = new Date().toISOString();
      }
    }

    await this.supabase.from('runs').update(patch).eq('id', runId);
  }

  async insertAgentEvent(event: {
    office_id: string;
    agent_id: string;
    task_id: string | null;
    type: AgentEventType;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.supabase.from('agent_events').insert(event);
  }

  async insertLlmCall(call: {
    task_id: string;
    agent_id: string;
    provider: LlmProvider;
    model: string;
    effort: EffortLevel;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cost_usd: number;
    latency_ms: number;
    error?: string | null;
  }): Promise<void> {
    await this.supabase.from('llm_calls').insert(call);
  }

  async insertArtifact(artifact: {
    run_id: string;
    task_id: string;
    kind: 'research_brief' | 'raw_clip' | 'edited_short' | 'subtitle_srt' | 'publish_report';
    storage_path: string | null;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    const { data, error } = await this.supabase
      .from('artifacts')
      .insert(artifact)
      .select('id')
      .single();

    if (error || !data) {
      return '00000000-0000-0000-0000-000000000000';
    }
    return String(data.id);
  }

  async insertVideoMetric(metric: {
    artifact_id: string;
    youtube_video_id: string;
    views: number;
    likes: number;
    comments: number;
    retention: number;
  }): Promise<void> {
    await this.supabase.rpc('record_video_metric_snapshot', {
      p_artifact_id: metric.artifact_id,
      p_youtube_video_id: metric.youtube_video_id,
      p_views: metric.views,
      p_likes: metric.likes,
      p_comments: metric.comments,
      p_retention: metric.retention,
    });
  }

  async createAndEnqueueTask(params: {
    run_id: string;
    office_id: string;
    agent_id: string;
    role_id: string;
    role_slug: RoleSlug;
    input: Record<string, unknown>;
    delay_sec?: number;
  }): Promise<string> {
    const { data, error } = await this.supabase
      .from('tasks')
      .insert({
        run_id: params.run_id,
        agent_id: params.agent_id,
        role_id: params.role_id,
        input: params.input,
        status: 'queued',
      })
      .select('id')
      .single();

    if (error || !data) {
      throw new Error(error?.message ?? 'Erro ao criar próxima task no pipeline.');
    }

    const taskId = String(data.id);
    await this.supabase.rpc('enqueue_agent_task', {
      p_task_id: taskId,
      p_run_id: params.run_id,
      p_office_id: params.office_id,
      p_agent_id: params.agent_id,
      p_role_slug: params.role_slug,
      p_delay_sec: params.delay_sec ?? 0,
    });

    return taskId;
  }

  async reenqueueExistingTask(params: {
    task_id: string;
    run_id: string;
    office_id: string;
    agent_id: string;
    role_slug: RoleSlug;
    delay_sec: number;
  }): Promise<void> {
    await this.supabase.rpc('enqueue_agent_task', {
      p_task_id: params.task_id,
      p_run_id: params.run_id,
      p_office_id: params.office_id,
      p_agent_id: params.agent_id,
      p_role_slug: params.role_slug,
      p_delay_sec: params.delay_sec,
    });
  }
}

export function createWorkerSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function recordWorkerHeartbeat(
  supabase: SupabaseClient,
  workerId: string,
  activeTasks: number,
  processedTasks: number,
): Promise<void> {
  await supabase.from('worker_heartbeats').upsert({
    worker_id: workerId,
    status: activeTasks > 0 ? 'busy' : 'online',
    active_tasks: activeTasks,
    processed_tasks: processedTasks,
    last_seen_at: new Date().toISOString(),
    metadata: {
      worker_version: '2026.11.24-supabase-yt-cache-v14',
      git_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'local',
      railway_deployment_id: process.env.RAILWAY_DEPLOYMENT_ID || null,
      node_version: process.version,
    },
  });
}

export async function pollAndDrainQueueBatch(
  supabase: SupabaseClient,
  repo: WorkerRepository,
  batchSize = 3,
): Promise<number> {
  const { data: messages, error } = await supabase.rpc('dequeue_agent_tasks', {
    p_visibility_timeout: 90,
    p_batch_size: batchSize,
  });

  if (error || !Array.isArray(messages) || messages.length === 0) {
    return 0;
  }

  let processedCount = 0;
  for (const msg of messages as { msg_id: number; message: { task_id?: string } }[]) {
    const taskId = msg.message?.task_id;
    if (taskId) {
      await processQueuedAgentTask(taskId, repo);
      processedCount++;
    }
    await supabase.rpc('ack_agent_task', { p_msg_id: msg.msg_id });
  }

  return processedCount;
}
