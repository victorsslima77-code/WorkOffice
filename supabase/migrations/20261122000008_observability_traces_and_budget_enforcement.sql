-- ==============================================================================
-- Etapa 8: Observabilidade, Traces, Saude do Worker e Controle de Orcamento (80%/100%)
-- Projeto Supabase alvo: jphdogyddahozpcgktdz
-- ==============================================================================

-- 1. RPC simulate_agent_budget_consumption:
-- Permite simular/testar o gatilho de 80% (alerta) ou 100% (pausa automatica na copa com budget.exceeded)
-- ou restaurar/despausar o orcamento de um agente.
create or replace function public.simulate_agent_budget_consumption(
  p_office_id uuid,
  p_agent_id uuid,
  p_action text default 'hit_100' -- 'hit_80' | 'hit_100' | 'restore'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.agents%rowtype;
  v_budget bigint;
  v_current_used bigint;
  v_target_tokens bigint;
  v_delta_tokens integer;
  v_dummy_run_id uuid;
  v_dummy_task_id uuid;
begin
  if auth.uid() is not null and not public.user_owns_office(p_office_id) then
    raise exception 'Sem permissao neste escritorio.' using errcode = '42501';
  end if;

  select *
  into v_agent
  from public.agents
  where id = p_agent_id
    and office_id = p_office_id;

  if not found then
    raise exception 'Agente nao encontrado.' using errcode = '22023';
  end if;

  v_budget := coalesce(v_agent.monthly_token_budget, 500000);
  if v_agent.monthly_token_budget is null then
    update public.agents
    set monthly_token_budget = v_budget
    where id = v_agent.id;
  end if;

  if p_action = 'restore' then
    update public.agents
    set
      monthly_token_budget = v_budget * 2,
      status = 'idle'
    where id = v_agent.id;

    insert into public.agent_events (office_id, agent_id, task_id, type, payload)
    values (
      p_office_id,
      v_agent.id,
      null,
      'agent.idle',
      jsonb_build_object(
        'message', format('Orçamento de %s ampliado para %s tokens/mês. Agente liberado!', v_agent.name, v_budget * 2)
      )
    );

    return jsonb_build_object(
      'agent_id', v_agent.id,
      'status', 'idle',
      'monthly_token_budget', v_budget * 2
    );
  end if;

  select coalesce(sum(input_tokens + output_tokens + reasoning_tokens), 0)
  into v_current_used
  from public.llm_calls
  where agent_id = v_agent.id
    and created_at >= date_trunc('month', now());

  if p_action = 'hit_80' then
    v_target_tokens := round(v_budget * 0.85);
  else
    v_target_tokens := v_budget + 1000;
  end if;

  v_delta_tokens := greatest(1000, (v_target_tokens - v_current_used)::integer);

  -- Garante uma run/task para vincular o registro em llm_calls
  select id into v_dummy_run_id
  from public.runs
  where office_id = p_office_id
  order by created_at desc
  limit 1;

  if v_dummy_run_id is null then
    insert into public.runs (office_id, input, status, started_at, finished_at)
    values (
      p_office_id,
      jsonb_build_object('instruction', 'Simulação de Orçamento Mensal'),
      'completed',
      now(),
      now()
    )
    returning id into v_dummy_run_id;
  end if;

  insert into public.tasks (run_id, agent_id, role_id, input, status, started_at, finished_at)
  values (
    v_dummy_run_id,
    v_agent.id,
    v_agent.role_id,
    jsonb_build_object('instruction', format('Ajuste de consumo mensal (%s)', p_action)),
    'completed',
    now(),
    now()
  )
  returning id into v_dummy_task_id;

  insert into public.llm_calls (
    task_id,
    agent_id,
    provider,
    model,
    effort,
    input_tokens,
    output_tokens,
    reasoning_tokens,
    cost_usd,
    latency_ms
  )
  values (
    v_dummy_task_id,
    v_agent.id,
    v_agent.provider,
    v_agent.model,
    v_agent.effort,
    round(v_delta_tokens * 0.6)::integer,
    round(v_delta_tokens * 0.4)::integer,
    0,
    round((v_delta_tokens::numeric / 1000000.0) * 4.5, 6),
    740
  );

  if p_action = 'hit_100' then
    update public.agents
    set status = 'paused_budget'
    where id = v_agent.id;

    -- Cancela tasks pendentes deste agente
    update public.tasks
    set
      status = 'cancelled',
      error_message = 'Bloqueado automaticamente: orçamento mensal atingiu 100%.',
      finished_at = now()
    where agent_id = v_agent.id
      and status in ('queued', 'running');

    insert into public.agent_events (office_id, agent_id, task_id, type, payload)
    values (
      p_office_id,
      v_agent.id,
      v_dummy_task_id,
      'budget.exceeded',
      jsonb_build_object(
        'message', format('ALERTA 100%%: %s atingiu o limite mensal de %s tokens! Tarefas bloqueadas e agente pausado na copa (💤).', v_agent.name, v_budget)
      )
    );
  end if;

  return jsonb_build_object(
    'agent_id', v_agent.id,
    'action', p_action,
    'tokens_added', v_delta_tokens,
    'monthly_token_budget', v_budget
  );
end;
$$;

revoke all on function public.simulate_agent_budget_consumption(uuid, uuid, text) from public, anon;
grant execute on function public.simulate_agent_budget_consumption(uuid, uuid, text) to authenticated, service_role;

-- 2. RPC get_office_observability_dashboard:
-- Retorna telemetria consolidada de llm_calls, tasks (traces), runs, video_metrics e worker_heartbeats
create or replace function public.get_office_observability_dashboard(
  p_office_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_llm_calls jsonb;
  v_tasks jsonb;
  v_worker_health jsonb;
  v_pending_queue integer;
  v_runs_count integer;
  v_published_shorts_count integer;
begin
  if auth.uid() is not null and not public.user_owns_office(p_office_id) then
    raise exception 'Sem permissao neste escritorio.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_to_json(c)), '[]'::jsonb)
  into v_llm_calls
  from (
    select
      lc.id,
      lc.task_id,
      lc.agent_id,
      a.name as agent_name,
      lc.provider,
      lc.model,
      lc.effort,
      lc.input_tokens,
      lc.output_tokens,
      lc.reasoning_tokens,
      lc.cost_usd,
      lc.latency_ms,
      lc.error,
      lc.created_at
    from public.llm_calls lc
    join public.agents a on a.id = lc.agent_id
    where a.office_id = p_office_id
    order by lc.created_at desc
    limit 120
  ) c;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  into v_tasks
  from (
    select
      tk.id,
      tk.run_id,
      tk.agent_id,
      a.name as agent_name,
      r.name as role_name,
      r.slug as role_slug,
      r.allowed_tools,
      tk.input,
      tk.output,
      tk.status,
      tk.attempts,
      tk.error_message,
      tk.started_at,
      tk.finished_at,
      tk.created_at
    from public.tasks tk
    join public.agents a on a.id = tk.agent_id
    join public.roles r on r.id = tk.role_id
    where a.office_id = p_office_id
    order by tk.created_at desc
    limit 40
  ) t;

  select count(*)
  into v_pending_queue
  from public.tasks tk
  join public.agents a on a.id = tk.agent_id
  where a.office_id = p_office_id
    and tk.status in ('queued', 'running');

  select count(*)
  into v_runs_count
  from public.runs
  where office_id = p_office_id;

  select count(*)
  into v_published_shorts_count
  from public.artifacts ar
  join public.runs r on r.id = ar.run_id
  where r.office_id = p_office_id
    and ar.kind = 'publish_report';

  select row_to_json(wh)::jsonb
  into v_worker_health
  from public.worker_heartbeats wh
  order by wh.last_seen_at desc
  limit 1;

  return jsonb_build_object(
    'llm_calls', v_llm_calls,
    'tasks', v_tasks,
    'pending_queue_count', v_pending_queue,
    'runs_count', v_runs_count,
    'published_shorts_count', v_published_shorts_count,
    'worker_health', coalesce(
      v_worker_health,
      jsonb_build_object(
        'worker_id', 'in-process-realtime-stepper',
        'status', 'online',
        'active_tasks', v_pending_queue,
        'last_seen_at', now()
      )
    )
  );
end;
$$;

revoke all on function public.get_office_observability_dashboard(uuid) from public, anon;
grant execute on function public.get_office_observability_dashboard(uuid) to authenticated, service_role;
