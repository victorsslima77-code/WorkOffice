import { describe, expect, it } from 'vitest';
import {
  buildProviderSpecificOptions,
  calculateBackoffDelaySeconds,
  executeRegisteredTool,
  getWorkerHealthStatus,
  processQueuedAgentTask,
  ToolPermissionError,
  type WorkerAgentRecord,
  type WorkerRepository,
  type WorkerTaskRecord,
} from '../index.js';

function createInMemoryWorkerRepository() {
  const officeId = '11111111-1111-1111-1111-111111111111';
  const runId = '22222222-2222-2222-2222-222222222222';

  const agents: Record<string, WorkerAgentRecord> = {
    'ag-scriptwriter': {
      id: 'ag-scriptwriter',
      office_id: officeId,
      role_id: 'role-sw',
      name: 'Lucas Roteirista',
      desk_slot: 'desk_1',
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      effort: 'low',
      monthly_token_budget: 500000,
      status: 'idle',
      role_slug: 'scriptwriter',
      allowed_tools: ['web_search', 'youtube_list_videos', 'fetch_transcript', 'read_source'],
      system_prompt: 'Roteirista de Shorts',
    },
    'ag-editor': {
      id: 'ag-editor',
      office_id: officeId,
      role_id: 'role-ed',
      name: 'Marina Editora',
      desk_slot: 'desk_2',
      provider: 'google',
      model: 'gemini-2.5-pro',
      effort: 'high',
      monthly_token_budget: 1500000,
      status: 'idle',
      role_slug: 'video_editor',
      allowed_tools: [
        'download_video_segment',
        'transcribe_audio',
        'cut_vertical_short',
        'burn_subtitles',
        'upload_artifact',
      ],
      system_prompt: 'Editora de Shorts',
    },
    'ag-publisher': {
      id: 'ag-publisher',
      office_id: officeId,
      role_id: 'role-pub',
      name: 'Rafael Publicador',
      desk_slot: 'desk_3',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      effort: 'low',
      monthly_token_budget: 300000,
      status: 'idle',
      role_slug: 'publisher_analyst',
      allowed_tools: ['youtube_upload_short', 'youtube_schedule_video', 'youtube_fetch_analytics'],
      system_prompt: 'Publicador de Shorts',
    },
  };

  const tasks = new Map<string, WorkerTaskRecord>();
  const events: {
    office_id: string;
    agent_id: string;
    task_id: string | null;
    type: string;
    payload: Record<string, unknown>;
  }[] = [];
  const llmCalls: {
    task_id: string;
    agent_id: string;
    provider: string;
    model: string;
    effort: string;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cost_usd: number;
  }[] = [];
  const artifacts: {
    id: string;
    run_id: string;
    task_id: string;
    kind: string;
    storage_path: string | null;
    metadata: Record<string, unknown>;
  }[] = [];
  const videoMetrics: {
    artifact_id: string;
    youtube_video_id: string;
    views: number;
    likes: number;
    comments: number;
    retention: number;
  }[] = [];

  let runStatus: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' = 'running';
  let runTokens = 0;
  let runCostUsd = 0;
  let taskCounter = 1;
  let failDecryptTimes = 0;

  tasks.set('task-1', {
    id: 'task-1',
    run_id: runId,
    agent_id: 'ag-scriptwriter',
    role_id: 'role-sw',
    input: {
      instruction: 'Crie 2 vídeos do vídeo game novo',
      video_index: 1,
      total_videos: 2,
    },
    status: 'queued',
    attempts: 0,
  });

  const repo: WorkerRepository = {
    async getTaskById(taskId) {
      return tasks.get(taskId) ?? null;
    },
    async getRunStatus() {
      return runStatus;
    },
    async getAgentWithRole(agentId) {
      return agents[agentId] ?? null;
    },
    async getAgentByOfficeAndRoleSlug(_officeId, roleSlug) {
      return Object.values(agents).find((a) => a.role_slug === roleSlug) ?? null;
    },
    async getNextRoleSlugsFromWorkflow(_officeId, currentRoleSlug) {
      if (currentRoleSlug === 'scriptwriter') return ['video_editor'];
      if (currentRoleSlug === 'video_editor') return ['publisher_analyst'];
      return [];
    },
    async getAgentMonthlyTokensUsed(agentId) {
      return llmCalls
        .filter((c) => c.agent_id === agentId)
        .reduce((s, c) => s + c.input_tokens + c.output_tokens + c.reasoning_tokens, 0);
    },
    async getDecryptedSecretForAgent(agentId) {
      if (failDecryptTimes > 0) {
        failDecryptTimes--;
        throw new Error('Falha temporaria de rede no Vault');
      }
      const ag = agents[agentId]!;
      return `wo_test_${ag.provider}_12345678`;
    },
    async updateTaskStatus(taskId, patch) {
      const cur = tasks.get(taskId);
      if (!cur) return;
      tasks.set(taskId, {
        ...cur,
        status: patch.status,
        attempts: patch.attempts ?? cur.attempts,
      });
    },
    async updateAgentStatus(agentId, status) {
      if (agents[agentId]) {
        agents[agentId]!.status = status;
      }
    },
    async updateRunTotalsAndStatus(_runId, deltaTokens, deltaCostUsd, nextStatus) {
      runTokens += deltaTokens;
      runCostUsd = Number((runCostUsd + deltaCostUsd).toFixed(6));
      if (nextStatus && runStatus !== 'cancelled') {
        runStatus = nextStatus;
      }
    },
    async insertAgentEvent(ev) {
      events.push(ev);
    },
    async insertLlmCall(call) {
      llmCalls.push(call);
    },
    async insertArtifact(art) {
      const id = `art-${artifacts.length + 1}`;
      artifacts.push({ id, ...art });
      return id;
    },
    async insertVideoMetric(metric) {
      videoMetrics.push(metric);
    },
    async createAndEnqueueTask(params) {
      taskCounter++;
      const newId = `task-${taskCounter}`;
      tasks.set(newId, {
        id: newId,
        run_id: params.run_id,
        agent_id: params.agent_id,
        role_id: params.role_id,
        input: params.input,
        status: 'queued',
        attempts: 0,
      });
      return newId;
    },
    async reenqueueExistingTask() {
      // No-op em memoria
    },
  };

  return {
    repo,
    agents,
    tasks,
    events,
    llmCalls,
    artifacts,
    videoMetrics,
    getRunState: () => ({ runStatus, runTokens, runCostUsd }),
    setRunStatus: (st: typeof runStatus) => {
      runStatus = st;
    },
    setFailDecryptTimes: (n: number) => {
      failDecryptTimes = n;
    },
  };
}

describe('@workoffice/worker — Etapa 5 (Worker Core, Multi-Provedor, Tool Registry e Handoff nas Estantes)', () => {
  it('retorna status de saude vinculado ao projeto Supabase alvo', () => {
    const health = getWorkerHealthStatus();
    expect(health.status).toBe('ok');
    expect(health.projectRef).toBe('jphdogyddahozpcgktdz');
    expect(health.supportedTemplates).toContain('youtube-shorts-studio');
  });

  it('mapeia opcoes de thinking/reasoning especificas de cada provedor conforme o esforco', () => {
    const anthropicHigh = buildProviderSpecificOptions(
      'anthropic',
      'claude-sonnet-4-20250514',
      'high',
    );
    expect(anthropicHigh.anthropic?.thinking).toEqual({
      type: 'enabled',
      budgetTokens: 16384,
    });

    const geminiHigh = buildProviderSpecificOptions('google', 'gemini-2.5-pro', 'high');
    expect(geminiHigh.google?.thinkingConfig).toEqual({
      thinkingBudget: 16384,
    });

    const openaiMedium = buildProviderSpecificOptions('openai', 'gpt-4.1', 'medium');
    expect(openaiMedium.openai?.reasoningEffort).toBe('medium');
  });

  it('bloqueia execucao de ferramenta nao autorizada para o cargo (allowed_tools)', async () => {
    await expect(
      executeRegisteredTool(
        'youtube_upload_short', // Ferramenta de Publicador
        {},
        {
          officeId: '11111111-1111-1111-1111-111111111111',
          runId: '22222222-2222-2222-2222-222222222222',
          taskId: 'task-1',
          agentId: 'ag-scriptwriter',
          roleSlug: 'scriptwriter',
          allowedTools: ['web_search', 'read_source'],
          videoIndex: 1,
          totalVideos: 1,
          instruction: 'Teste',
          emitVisualEvent: async () => {},
        },
      ),
    ).rejects.toThrow(ToolPermissionError);
  });

  it('executa fluxo de ponta a ponta multi-provedor (Haiku low -> Gemini Pro high -> GPT Mini low) com entregas nas estantes e simultaneidade', async () => {
    const env = createInMemoryWorkerRepository();
    const queue: string[] = ['task-1'];

    // Drena a fila ate esvaziar (2 videos solicitados x 3 cargos = 6 tasks)
    while (queue.length > 0) {
      const nextTaskId = queue.shift()!;
      const outcome = await processQueuedAgentTask(nextTaskId, env.repo);
      expect(outcome.status).toBe('completed');
      queue.push(...outcome.spawnedTaskIds);
    }

    // 2 videos x 3 cargos = 6 chamadas LLM (2 Haiku low, 2 Gemini Pro high, 2 GPT Mini low)
    expect(env.llmCalls).toHaveLength(6);
    expect(env.artifacts).toHaveLength(6);
    expect(env.videoMetrics).toHaveLength(2);

    // Verifica que os handoffs foram enviados para as estantes dos destinatarios (desk_2 e desk_3)
    const handoffSentEvents = env.events.filter((e) => e.type === 'handoff.sent');
    expect(handoffSentEvents).toHaveLength(4);
    expect(handoffSentEvents.some((e) => e.payload.targetDeskSlot === 'desk_2')).toBe(true);
    expect(handoffSentEvents.some((e) => e.payload.targetDeskSlot === 'desk_3')).toBe(true);

    // Verifica que a Run completou e contabilizou tokens e custo USD
    const runState = env.getRunState();
    expect(runState.runStatus).toBe('completed');
    expect(runState.runTokens).toBeGreaterThan(0);
    expect(runState.runCostUsd).toBeGreaterThan(0);
  });

  it('aplica retry com backoff exponencial em falha transitoria e pausa agente ao estourar orcamento mensal', async () => {
    expect(calculateBackoffDelaySeconds(1, 3)).toBe(3);
    expect(calculateBackoffDelaySeconds(2, 3)).toBe(6);
    expect(calculateBackoffDelaySeconds(3, 3)).toBe(12);

    const env = createInMemoryWorkerRepository();
    env.setFailDecryptTimes(1);

    // 1a tentativa falha transitoriamente e agenda retry
    const firstTry = await processQueuedAgentTask('task-1', env.repo);
    expect(firstTry.status).toBe('retried');

    // 2a tentativa sucede
    const secondTry = await processQueuedAgentTask('task-1', env.repo);
    expect(secondTry.status).toBe('completed');

    // Simula estouro de orcamento mensal no Roteirista
    env.agents['ag-scriptwriter']!.monthly_token_budget = 100;
    const nextScriptTask = secondTry.spawnedTaskIds.find(
      (id) => env.tasks.get(id)?.agent_id === 'ag-scriptwriter',
    )!;
    const budgetOutcome = await processQueuedAgentTask(nextScriptTask, env.repo);
    expect(budgetOutcome.status).toBe('paused_budget');
    expect(env.agents['ag-scriptwriter']!.status).toBe('paused_budget');
    expect(env.events.some((e) => e.type === 'budget.exceeded')).toBe(true);
  });
});
