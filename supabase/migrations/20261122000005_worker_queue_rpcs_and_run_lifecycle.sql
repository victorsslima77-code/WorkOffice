-- ==============================================================================
-- Etapa 5: Worker Heartbeats, RPCs de Fila (pgmq) e Ciclo de Vida de Runs/Tasks
-- Projeto Supabase alvo: jphdogyddahozpcgktdz
-- ==============================================================================

-- 1. Tabela de Heartbeat de Saude do Worker
create table if not exists public.worker_heartbeats (
  worker_id text primary key,
  status text not null default 'online' check (status in ('online', 'busy', 'offline')),
  active_tasks integer not null default 0,
  processed_tasks bigint not null default 0,
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);

alter table public.worker_heartbeats enable row level security;
alter table public.worker_heartbeats force row level security;

drop policy if exists "worker_heartbeats_select_authenticated" on public.worker_heartbeats;
create policy "worker_heartbeats_select_authenticated"
  on public.worker_heartbeats
  for select
  to authenticated
  using (true);

-- 2. RPCs Wrappers para a fila pgmq ('agent_tasks')
create or replace function public.enqueue_agent_task(
  p_task_id uuid,
  p_run_id uuid,
  p_office_id uuid,
  p_agent_id uuid,
  p_role_slug text,
  p_delay_sec integer default 0
)
returns bigint
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_msg_id bigint;
begin
  select pgmq.send(
    'agent_tasks',
    jsonb_build_object(
      'task_id', p_task_id,
      'run_id', p_run_id,
      'office_id', p_office_id,
      'agent_id', p_agent_id,
      'role_slug', p_role_slug,
      'enqueued_at', now()
    ),
    greatest(0, coalesce(p_delay_sec, 0))
  )
  into v_msg_id;

  return v_msg_id;
exception
  when others then
    return -1;
end;
$$;

revoke all on function public.enqueue_agent_task(uuid, uuid, uuid, uuid, text, integer) from public, anon;
grant execute on function public.enqueue_agent_task(uuid, uuid, uuid, uuid, text, integer) to authenticated, service_role;

create or replace function public.dequeue_agent_tasks(
  p_visibility_timeout integer default 60,
  p_batch_size integer default 3
)
returns table (
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
)
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  return query
  select
    q.msg_id,
    q.read_ct,
    q.enqueued_at,
    q.vt,
    q.message
  from pgmq.read(
    'agent_tasks',
    greatest(5, coalesce(p_visibility_timeout, 60)),
    greatest(1, least(10, coalesce(p_batch_size, 3)))
  ) as q;
end;
$$;

revoke all on function public.dequeue_agent_tasks(integer, integer) from public, anon, authenticated;
grant execute on function public.dequeue_agent_tasks(integer, integer) to service_role;

create or replace function public.ack_agent_task(
  p_msg_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_archived boolean;
begin
  select pgmq.archive('agent_tasks', p_msg_id) into v_archived;
  return coalesce(v_archived, false);
end;
$$;

revoke all on function public.ack_agent_task(bigint) from public, anon, authenticated;
grant execute on function public.ack_agent_task(bigint) to service_role;

-- 3. RPC create_office_run: Cria Run, Task #1 do Roteirista, emite evento e enfileira no pgmq
create or replace function public.create_office_run(
  p_office_id uuid,
  p_instruction text,
  p_clip_count integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_clean_instruction text;
  v_total_videos integer;
  v_scriptwriter_agent record;
  v_run_id uuid;
  v_task_id uuid;
  v_msg_id bigint;
begin
  if auth.uid() is not null and not public.user_owns_office(p_office_id) then
    raise exception 'Sem permissao para iniciar execucao neste escritorio.' using errcode = '42501';
  end if;

  v_clean_instruction := trim(coalesce(p_instruction, ''));
  if char_length(v_clean_instruction) < 3 then
    raise exception 'Informe uma instrucao valida para o Roteirista.' using errcode = '22023';
  end if;

  v_total_videos := greatest(1, least(10, coalesce(p_clip_count, 3)));

  -- Localiza o agente Roteirista (ou o primeiro agente contratado no escritorio)
  select
    a.id as agent_id,
    a.name as agent_name,
    a.role_id,
    r.slug as role_slug,
    a.desk_slot
  into v_scriptwriter_agent
  from public.agents a
  join public.roles r on r.id = a.role_id
  where a.office_id = p_office_id
  order by
    case when r.slug = 'scriptwriter' then 0 else 1 end,
    a.desk_slot asc
  limit 1;

  if not found then
    raise exception 'Nenhum agente contratado neste escritorio.' using errcode = '22023';
  end if;

  insert into public.runs (
    office_id,
    input,
    status,
    started_at
  )
  values (
    p_office_id,
    jsonb_build_object(
      'instruction', v_clean_instruction,
      'clip_count', v_total_videos
    ),
    'running',
    now()
  )
  returning id into v_run_id;

  insert into public.tasks (
    run_id,
    agent_id,
    role_id,
    input,
    status
  )
  values (
    v_run_id,
    v_scriptwriter_agent.agent_id,
    v_scriptwriter_agent.role_id,
    jsonb_build_object(
      'instruction', v_clean_instruction,
      'video_index', 1,
      'total_videos', v_total_videos,
      'podcast_name', 'Canal Alvo',
      'channel_url', 'https://www.youtube.com/@podcast',
      'topic', v_clean_instruction,
      'clip_count', 1
    ),
    'queued'
  )
  returning id into v_task_id;

  update public.agents
  set status = 'working'
  where id = v_scriptwriter_agent.agent_id;

  insert into public.agent_events (
    office_id,
    agent_id,
    task_id,
    type,
    payload
  )
  values (
    p_office_id,
    v_scriptwriter_agent.agent_id,
    v_task_id,
    'task.started',
    jsonb_build_object(
      'message', format('Instrução recebida: "%s" (Vídeo #1/%s)', v_clean_instruction, v_total_videos),
      'videoNumber', 1,
      'totalVideos', v_total_videos
    )
  );

  v_msg_id := public.enqueue_agent_task(
    v_task_id,
    v_run_id,
    p_office_id,
    v_scriptwriter_agent.agent_id,
    v_scriptwriter_agent.role_slug,
    0
  );

  return jsonb_build_object(
    'run_id', v_run_id,
    'first_task_id', v_task_id,
    'agent_id', v_scriptwriter_agent.agent_id,
    'total_videos', v_total_videos,
    'queue_msg_id', v_msg_id
  );
end;
$$;

revoke all on function public.create_office_run(uuid, text, integer) from public, anon;
grant execute on function public.create_office_run(uuid, text, integer) to authenticated, service_role;

-- 4. RPC cancel_office_run: Interrompe atividades de um agente ou de todo o escritorio e manda descansar na copa
create or replace function public.cancel_office_run(
  p_office_id uuid,
  p_run_id uuid default null,
  p_agent_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cancelled_tasks integer := 0;
  v_cancelled_runs integer := 0;
  v_ag record;
begin
  if auth.uid() is not null and not public.user_owns_office(p_office_id) then
    raise exception 'Sem permissao para interromper atividades neste escritorio.' using errcode = '42501';
  end if;

  update public.tasks t
  set
    status = 'cancelled',
    error_message = 'Interrompido manualmente pelo usuario (mandado descansar).',
    finished_at = now()
  from public.runs r
  where t.run_id = r.id
    and r.office_id = p_office_id
    and (p_run_id is null or r.id = p_run_id)
    and (p_agent_id is null or t.agent_id = p_agent_id)
    and t.status in ('queued', 'running');

  get diagnostics v_cancelled_tasks = row_count;

  if p_agent_id is null then
    update public.runs r
    set
      status = 'cancelled',
      finished_at = now()
    where r.office_id = p_office_id
      and (p_run_id is null or r.id = p_run_id)
      and r.status in ('queued', 'running');

    get diagnostics v_cancelled_runs = row_count;
  end if;

  for v_ag in
    select id, name
    from public.agents
    where office_id = p_office_id
      and (p_agent_id is null or id = p_agent_id)
  loop
    update public.agents
    set status = 'idle'
    where id = v_ag.id;

    insert into public.agent_events (
      office_id,
      agent_id,
      task_id,
      type,
      payload
    )
    values (
      p_office_id,
      v_ag.id,
      null,
      'agent.idle',
      jsonb_build_object(
        'message', format('Atividade interrompida pelo usuário! %s foi mandado descansar na copa.', v_ag.name)
      )
    );
  end loop;

  return jsonb_build_object(
    'cancelled_tasks', v_cancelled_tasks,
    'cancelled_runs', v_cancelled_runs
  );
end;
$$;

revoke all on function public.cancel_office_run(uuid, uuid, uuid) from public, anon;
grant execute on function public.cancel_office_run(uuid, uuid, uuid) to authenticated, service_role;
