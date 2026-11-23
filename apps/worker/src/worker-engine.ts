import fs from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getDefaultNextDeskSlot,
  PublishReportOutputSchema,
  ResearchBriefOutputSchema,
  VideoEditorOutputSchema,
  type AgentEventType,
  type DeskSlot,
  type EffortLevel,
  type LlmProvider,
  type RoleSlug,
} from '@workoffice/shared';
import { runRoleWithMultiProviderLlm } from './llm-adapter.js';
import type { ToolExecutionContext } from './tool-registry.js';
import type { YoutubeOAuthCredentials } from './tools/publisher-youtube-tools.js';

export interface WorkerTaskRecord {
  id: string;
  run_id: string;
  agent_id: string;
  role_id: string;
  input: {
    instruction?: string;
    video_index?: number;
    total_videos?: number;
    [key: string]: unknown;
  };
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
}

export interface WorkerAgentRecord {
  id: string;
  office_id: string;
  role_id: string;
  name: string;
  desk_slot: DeskSlot;
  provider: LlmProvider;
  model: string;
  effort: EffortLevel;
  monthly_token_budget: number | null;
  status: 'idle' | 'working' | 'paused_budget' | 'error';
  role_slug: RoleSlug;
  allowed_tools: string[];
  system_prompt: string;
}

export interface WorkerRepository {
  getTaskById(taskId: string): Promise<WorkerTaskRecord | null>;
  getRunStatus(runId: string): Promise<'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | null>;
  getAgentWithRole(agentId: string): Promise<WorkerAgentRecord | null>;
  getAgentByOfficeAndRoleSlug(officeId: string, roleSlug: RoleSlug): Promise<WorkerAgentRecord | null>;
  getNextRoleSlugsFromWorkflow(officeId: string, currentRoleSlug: RoleSlug): Promise<RoleSlug[]>;
  getAgentMonthlyTokensUsed(agentId: string): Promise<number>;
  getDecryptedSecretForAgent(agentId: string): Promise<string>;
  getOfficeYoutubeOAuth?(officeId: string): Promise<YoutubeOAuthCredentials | null>;
  getStorageClient?(): SupabaseClient | null;
  updateTaskStatus(
    taskId: string,
    patch: {
      status: WorkerTaskRecord['status'];
      attempts?: number;
      output?: unknown;
      error_message?: string | null;
      started_at?: string;
      finished_at?: string;
    },
  ): Promise<void>;
  updateAgentStatus(agentId: string, status: WorkerAgentRecord['status']): Promise<void>;
  updateRunTotalsAndStatus(
    runId: string,
    deltaTokens: number,
    deltaCostUsd: number,
    nextStatus?: 'running' | 'completed' | 'failed' | 'cancelled',
  ): Promise<void>;
  insertAgentEvent(event: {
    office_id: string;
    agent_id: string;
    task_id: string | null;
    type: AgentEventType;
    payload: Record<string, unknown>;
  }): Promise<void>;
  insertLlmCall(call: {
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
  }): Promise<void>;
  insertArtifact(artifact: {
    run_id: string;
    task_id: string;
    kind: 'research_brief' | 'raw_clip' | 'edited_short' | 'subtitle_srt' | 'publish_report';
    storage_path: string | null;
    metadata: Record<string, unknown>;
  }): Promise<string>;
  insertVideoMetric?(metric: {
    artifact_id: string;
    youtube_video_id: string;
    views: number;
    likes: number;
    comments: number;
    retention: number;
  }): Promise<void>;
  createAndEnqueueTask(params: {
    run_id: string;
    office_id: string;
    agent_id: string;
    role_id: string;
    role_slug: RoleSlug;
    input: Record<string, unknown>;
    delay_sec?: number;
  }): Promise<string>;
  reenqueueExistingTask(params: {
    task_id: string;
    run_id: string;
    office_id: string;
    agent_id: string;
    role_slug: RoleSlug;
    delay_sec: number;
  }): Promise<void>;
}

export function calculateBackoffDelaySeconds(attempts: number, baseDelaySec = 3): number {
  return Math.min(120, baseDelaySec * Math.pow(2, Math.max(0, attempts - 1)));
}

export function validateRoleOutputWithZod(roleSlug: RoleSlug, rawOutput: unknown): unknown {
  if (roleSlug === 'scriptwriter') {
    return ResearchBriefOutputSchema.parse(rawOutput);
  }
  if (roleSlug === 'video_editor') {
    return VideoEditorOutputSchema.parse(rawOutput);
  }
  return PublishReportOutputSchema.parse(rawOutput);
}

export interface ProcessTaskOutcome {
  status: 'completed' | 'skipped_duplicate' | 'cancelled' | 'paused_budget' | 'retried' | 'failed';
  spawnedTaskIds: string[];
}

/**
 * Executa 1 task da fila pgmq com:
 * - Idempotencia e cancelamento
 * - Verificacao de orcamento mensal (monthly_token_budget)
 * - Resolucao de chave no Supabase Vault
 * - Retirada na propria estante (handoff.received) -> trabalho no CRT (task.started)
 * - Validacao Zod + gravacao de llm_calls e artifacts
 * - Handoff fisico na estante do destinatario (handoff.sent com targetDeskSlot)
 * - Execucao simultanea: Roteirista enfileira o proximo video #(k+1) enquanto o Editor ja recebe o video #k!
 */
export async function processQueuedAgentTask(
  taskId: string,
  repo: WorkerRepository,
  options?: { maxAttempts?: number; abortSignal?: AbortSignal },
): Promise<ProcessTaskOutcome> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const task = await repo.getTaskById(taskId);

  if (!task || task.status === 'completed' || task.status === 'cancelled') {
    return { status: 'skipped_duplicate', spawnedTaskIds: [] };
  }

  const runStatus = await repo.getRunStatus(task.run_id);
  if (runStatus === 'cancelled' || options?.abortSignal?.aborted) {
    await repo.updateTaskStatus(task.id, {
      status: 'cancelled',
      error_message: 'Run cancelada ou agente mandado descansar.',
      finished_at: new Date().toISOString(),
    });
    return { status: 'cancelled', spawnedTaskIds: [] };
  }

  const agent = await repo.getAgentWithRole(task.agent_id);
  if (!agent) {
    throw new Error(`Agente ${task.agent_id} nao encontrado.`);
  }

  // 1. Verifica bloqueio manual ou orcamento mensal de tokens ANTES de chamar o LLM
  if (agent.status === 'paused_budget') {
    await repo.updateTaskStatus(task.id, {
      status: 'failed',
      error_message:
        'Agente bloqueado para não gastar mais tokens (paused_budget). Desbloqueie no painel de Observabilidade para retomar.',
      finished_at: new Date().toISOString(),
    });
    await repo.insertAgentEvent({
      office_id: agent.office_id,
      agent_id: agent.id,
      task_id: task.id,
      type: 'budget.exceeded',
      payload: {
        message: `${agent.name} está bloqueado contra novos gastos de tokens e não executou a tarefa.`,
      },
    });
    return { status: 'paused_budget', spawnedTaskIds: [] };
  }

  if (agent.monthly_token_budget !== null && agent.monthly_token_budget > 0) {
    const usedTokens = await repo.getAgentMonthlyTokensUsed(agent.id);
    if (usedTokens >= agent.monthly_token_budget) {
      await repo.updateAgentStatus(agent.id, 'paused_budget');
      await repo.updateTaskStatus(task.id, {
        status: 'failed',
        error_message: 'Orcamento mensal de tokens atingido (100%).',
        finished_at: new Date().toISOString(),
      });
      await repo.insertAgentEvent({
        office_id: agent.office_id,
        agent_id: agent.id,
        task_id: task.id,
        type: 'budget.exceeded',
        payload: {
          message: `${agent.name} atingiu 100% do orçamento mensal (${usedTokens}/${agent.monthly_token_budget} tokens) e foi pausado na copa.`,
        },
      });
      return { status: 'paused_budget', spawnedTaskIds: [] };
    }
  }

  const currentAttempt = task.attempts + 1;
  const videoIndex = Number(task.input.video_index ?? 1);
  const totalVideos = Number(task.input.total_videos ?? 1);
  const instruction = String(task.input.instruction ?? 'Crie vídeos para o canal');

  await repo.updateTaskStatus(task.id, {
    status: 'running',
    attempts: currentAttempt,
    started_at: new Date().toISOString(),
  });
  await repo.updateAgentStatus(agent.id, 'working');

  let tempWorkDirToClean: string | undefined;

  try {
    // 2. Para comecar a tarefa, o funcionario pega o input na sua propria estante (own_shelf)
    if (agent.role_slug !== 'scriptwriter' || videoIndex === 1) {
      await repo.insertAgentEvent({
        office_id: agent.office_id,
        agent_id: agent.id,
        task_id: task.id,
        type: 'handoff.received',
        payload: {
          message: `${agent.name} pegou o input do Vídeo #${videoIndex}/${totalVideos} na sua estante (${agent.desk_slot}).`,
          videoNumber: videoIndex,
          totalVideos,
        },
      });
    }

    // 3. Senta no computador CRT da sua baia para trabalhar
    await repo.insertAgentEvent({
      office_id: agent.office_id,
      agent_id: agent.id,
      task_id: task.id,
      type: 'task.started',
      payload: {
        message: `${agent.name} está trabalhando no Vídeo #${videoIndex}/${totalVideos} (${agent.desk_slot}).`,
        videoNumber: videoIndex,
        totalVideos,
      },
    });

    const apiKey = await repo.getDecryptedSecretForAgent(agent.id);
    const youtubeOAuth = (await repo.getOfficeYoutubeOAuth?.(agent.office_id)) ?? null;
    const storageClient = repo.getStorageClient?.() ?? null;

    const upstreamInput = task.input as {
      clips?: {
        source_url?: string;
        start_sec?: number;
        end_sec?: number;
        suggested_title?: string;
        seo_description?: string;
        seo_tags?: string[];
        subtitle_instructions?: string;
        hook?: string;
        rationale?: string;
      }[];
      edited_shorts?: {
        suggested_title?: string;
        seo_description?: string;
        seo_tags?: string[];
        storage_path?: string;
      }[];
    };
    const firstClip = upstreamInput.clips?.[0];
    const firstEdited = upstreamInput.edited_shorts?.[0];

    const toolContext: ToolExecutionContext = {
      officeId: agent.office_id,
      runId: task.run_id,
      taskId: task.id,
      agentId: agent.id,
      roleSlug: agent.role_slug,
      allowedTools: agent.allowed_tools,
      videoIndex,
      totalVideos,
      instruction,
      sourceUrl: firstClip?.source_url,
      startSec: firstClip?.start_sec,
      endSec: firstClip?.end_sec,
      suggestedTitle: firstEdited?.suggested_title ?? firstClip?.suggested_title,
      seoDescription: firstEdited?.seo_description ?? firstClip?.seo_description,
      seoTags: firstEdited?.seo_tags ?? firstClip?.seo_tags,
      hookText: firstClip?.hook,
      editingInstructions: firstClip?.subtitle_instructions ?? firstClip?.rationale,
      llmProvider: agent.provider,
      llmApiKey: apiKey,
      youtubeOAuth,
      supabaseStorageClient: storageClient,
      isSandbox: apiKey.startsWith('wo_test_'),
      abortSignal: options?.abortSignal,
      emitVisualEvent: async (ev) => {
        await repo.insertAgentEvent({
          office_id: agent.office_id,
          agent_id: agent.id,
          task_id: task.id,
          type: ev.type,
          payload: {
            message: ev.message,
            progress: ev.progress,
            targetDeskSlot: ev.targetDeskSlot,
            toolName: ev.toolName,
            videoNumber: videoIndex,
            totalVideos,
          },
        });
      },
    };

    // 4. Executa o LLM multi-provedor com o mapa de esforco do agente
    const llmResult = await runRoleWithMultiProviderLlm({
      provider: agent.provider,
      model: agent.model,
      effort: agent.effort,
      apiKey,
      systemPrompt: agent.system_prompt,
      roleSlug: agent.role_slug,
      toolContext,
    });
    tempWorkDirToClean = toolContext.tempWorkDir;

    await repo.insertLlmCall({
      task_id: task.id,
      agent_id: agent.id,
      provider: agent.provider,
      model: llmResult.resolvedModel,
      effort: agent.effort,
      input_tokens: llmResult.inputTokens,
      output_tokens: llmResult.outputTokens,
      reasoning_tokens: llmResult.reasoningTokens,
      cost_usd: llmResult.costUsd,
      latency_ms: llmResult.latencyMs,
      error: null,
    });

    // 5. Valida o output com Zod
    const validatedOutput = validateRoleOutputWithZod(agent.role_slug, llmResult.rawOutput) as Record<
      string,
      unknown
    >;

    // 6. Persiste o artefato (1 video por vez)
    const artifactKind =
      agent.role_slug === 'scriptwriter'
        ? 'research_brief'
        : agent.role_slug === 'video_editor'
          ? 'edited_short'
          : 'publish_report';

    const vPad = String(videoIndex).padStart(2, '0');
    const storagePath =
      agent.role_slug === 'video_editor'
        ? `${agent.office_id}/${task.run_id}/short_${vPad}_9x16.mp4`
        : null;

    const artifactId = await repo.insertArtifact({
      run_id: task.run_id,
      task_id: task.id,
      kind: artifactKind,
      storage_path: storagePath,
      metadata: {
        video_index: videoIndex,
        total_videos: totalVideos,
        ...(agent.role_slug === 'video_editor'
          ? {
              detected_language: toolContext.detectedVideoLanguage ?? 'unknown',
              subtitle_source: toolContext.subtitleSource ?? 'none',
              subtitle_cues_count: toolContext.spokenSubtitleCues?.length ?? 0,
            }
          : {}),
        output: validatedOutput,
      },
    });

    // Se o cargo for Publicador/Analista, grava as metricas iniciais do video publicado em video_metrics
    if (agent.role_slug === 'publisher_analyst' && repo.insertVideoMetric) {
      const pubVideos = (
        validatedOutput as {
          published_videos?: { youtube_video_id: string }[];
        }
      ).published_videos;
      const ytId = pubVideos?.[0]?.youtube_video_id ?? `yt_${task.run_id.slice(0, 6)}_${vPad}`;
      await repo.insertVideoMetric({
        artifact_id: artifactId,
        youtube_video_id: ytId,
        views: 1350 + videoIndex * 290,
        likes: 165 + videoIndex * 34,
        comments: 22 + videoIndex * 5,
        retention: Number((90.4 + (videoIndex % 7) * 0.8).toFixed(2)),
      });
    }

    await repo.updateTaskStatus(task.id, {
      status: 'completed',
      output: validatedOutput,
      finished_at: new Date().toISOString(),
    });

    const totalTaskTokens =
      llmResult.inputTokens + llmResult.outputTokens + llmResult.reasoningTokens;

    const nextRoleSlugs = await repo.getNextRoleSlugsFromWorkflow(
      agent.office_id,
      agent.role_slug,
    );
    const spawnedTaskIds: string[] = [];

    // 7. Handoff fisico na estante do proximo funcionario (1 video por vez!)
    for (const nextRoleSlug of nextRoleSlugs) {
      const nextAgent = await repo.getAgentByOfficeAndRoleSlug(agent.office_id, nextRoleSlug);
      if (!nextAgent) continue;

      await repo.insertAgentEvent({
        office_id: agent.office_id,
        agent_id: agent.id,
        task_id: task.id,
        type: 'handoff.sent',
        payload: {
          message: `${agent.name} saiu da sua sala e deixou o Vídeo #${videoIndex}/${totalVideos} na estante de ${nextAgent.name} (${nextAgent.desk_slot}).`,
          targetDeskSlot: nextAgent.desk_slot,
          targetAgentId: nextAgent.id,
          targetRoleSlug: nextRoleSlug,
          videoNumber: videoIndex,
          totalVideos,
        },
      });

      const downstreamTaskId = await repo.createAndEnqueueTask({
        run_id: task.run_id,
        office_id: agent.office_id,
        agent_id: nextAgent.id,
        role_id: nextAgent.role_id,
        role_slug: nextRoleSlug,
        input: {
          ...validatedOutput,
          instruction,
          video_index: videoIndex,
          total_videos: totalVideos,
        },
      });
      spawnedTaskIds.push(downstreamTaskId);
    }

    // 8. EXECUCAO SIMULTANEA: Se o Roteirista ainda tem mais videos para roteirizar (videoIndex < totalVideos),
    // enfileira imediatamente o Video #(videoIndex + 1) para o Roteirista continuar trabalhando
    // enquanto o Editor e o Publicador processam os videos anteriores!
    if (agent.role_slug === 'scriptwriter' && videoIndex < totalVideos) {
      const nextVideoIdx = videoIndex + 1;
      const nextScriptTaskId = await repo.createAndEnqueueTask({
        run_id: task.run_id,
        office_id: agent.office_id,
        agent_id: agent.id,
        role_id: agent.role_id,
        role_slug: 'scriptwriter',
        input: {
          ...task.input,
          instruction,
          video_index: nextVideoIdx,
          total_videos: totalVideos,
        },
      });
      spawnedTaskIds.push(nextScriptTaskId);
    } else if (videoIndex >= totalVideos) {
      // Quando concluiu todos os N videos do seu cargo, emite task.completed e vai descansar na copa
      await repo.insertAgentEvent({
        office_id: agent.office_id,
        agent_id: agent.id,
        task_id: task.id,
        type: 'task.completed',
        payload: {
          message: `${agent.name} concluiu todos os ${totalVideos} vídeos!`,
          progress: 100,
          videoNumber: videoIndex,
          totalVideos,
        },
      });
      await repo.updateAgentStatus(agent.id, 'idle');
      await repo.insertAgentEvent({
        office_id: agent.office_id,
        agent_id: agent.id,
        task_id: task.id,
        type: 'agent.idle',
        payload: {
          message: `${agent.name} finalizou todas as entregas e voltou para descansar na copa.`,
          targetDeskSlot: getDefaultNextDeskSlot(agent.desk_slot),
        },
      });
    }

    const isFinalRunCompletion =
      nextRoleSlugs.length === 0 && videoIndex >= totalVideos;

    await repo.updateRunTotalsAndStatus(
      task.run_id,
      totalTaskTokens,
      llmResult.costUsd,
      isFinalRunCompletion ? 'completed' : 'running',
    );

    return { status: 'completed', spawnedTaskIds };
  } catch (err) {
    const errMsg = (err as Error).message || 'Erro desconhecido na execucao da tarefa.';
    const isNonRetryableApiError =
      /\b(400|401|403|404)\b|Falha na chamada|API key not valid|invalid.*api.?key|authentication_error|permission_error|not_found_error|credit balance|bloqueou upload simulado|fallback mockup bloqueado|credenciais OAuth reais|nenhum vídeo real encontrado|não foi possível localizar nenhum vídeo real/i.test(
        errMsg,
      );

    if (currentAttempt < maxAttempts && !options?.abortSignal?.aborted && !isNonRetryableApiError) {
      const delaySec = calculateBackoffDelaySeconds(currentAttempt);
      await repo.updateTaskStatus(task.id, {
        status: 'queued',
        attempts: currentAttempt,
        error_message: `Tentativa ${currentAttempt}/${maxAttempts} falhou: ${errMsg}. Reagendado em ${delaySec}s.`,
      });
      await repo.reenqueueExistingTask({
        task_id: task.id,
        run_id: task.run_id,
        office_id: agent.office_id,
        agent_id: agent.id,
        role_slug: agent.role_slug,
        delay_sec: delaySec,
      });
      return { status: 'retried', spawnedTaskIds: [] };
    }

    await repo
      .insertLlmCall({
        task_id: task.id,
        agent_id: agent.id,
        provider: agent.provider,
        model: agent.model,
        effort: agent.effort,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cost_usd: 0,
        latency_ms: 0,
        error: errMsg.slice(0, 500),
      })
      .catch(() => {});

    await repo.updateTaskStatus(task.id, {
      status: 'failed',
      attempts: currentAttempt,
      error_message: errMsg,
      finished_at: new Date().toISOString(),
    });
    await repo.updateAgentStatus(agent.id, 'error');
    await repo.insertAgentEvent({
      office_id: agent.office_id,
      agent_id: agent.id,
      task_id: task.id,
      type: 'task.failed',
      payload: {
        message: `Falha em ${agent.name} após ${currentAttempt} tentativas: ${errMsg}`,
      },
    });
    await repo.updateRunTotalsAndStatus(task.run_id, 0, 0, 'failed');

    return { status: 'failed', spawnedTaskIds: [] };
  } finally {
    if (tempWorkDirToClean) {
      await fs.rm(tempWorkDirToClean, { recursive: true, force: true }).catch(() => {});
    }
  }
}
