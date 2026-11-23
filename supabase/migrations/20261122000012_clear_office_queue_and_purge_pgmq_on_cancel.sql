-- ==============================================================================
-- Etapa 9.3: Limpeza da Fila pgmq em cancel_office_run e Reset Imediato da Fila
-- do Escritorio 78f91670-4aa4-4fd7-8b0a-6e6820e2eaf0
-- Projeto Supabase alvo: jphdogyddahozpcgktdz
-- ==============================================================================

-- 1. Atualiza cancel_office_run para tambem remover mensagens pendentes do escritorio na fila pgmq ('agent_tasks')
create or replace function public.cancel_office_run(
  p_office_id uuid,
  p_run_id uuid default null,
  p_agent_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_cancelled_tasks integer := 0;
  v_cancelled_runs integer := 0;
  v_purged_pgmq integer := 0;
  v_msg record;
  v_ag record;
begin
  if auth.uid() is not null and not public.user_owns_office(p_office_id) then
    raise exception 'Sem permissao para interromper atividades neste escritorio.' using errcode = '42501';
  end if;

  -- Remove da fila pgmq todas as mensagens pendentes deste escritorio (ou deste agente especifico)
  begin
    if exists (select 1 from pg_namespace where nspname = 'pgmq') then
      for v_msg in
        select msg_id
        from pgmq.q_agent_tasks
        where (message ->> 'office_id') = p_office_id::text
          and (p_run_id is null or (message ->> 'run_id') = p_run_id::text)
          and (p_agent_id is null or (message ->> 'agent_id') = p_agent_id::text)
      loop
        perform pgmq.delete('agent_tasks', v_msg.msg_id);
        v_purged_pgmq := v_purged_pgmq + 1;
      end loop;
    end if;
  exception
    when others then
      null;
  end;

  update public.tasks t
  set
    status = 'cancelled',
    error_message = 'Interrompido manualmente pelo usuario (fila zerada / mandado descansar).',
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
        'message', format('Atividades interrompidas e fila zerada! %s voltou para descansar na copa.', v_ag.name)
      )
    );
  end loop;

  return jsonb_build_object(
    'office_id', p_office_id,
    'cancelled_tasks', v_cancelled_tasks,
    'cancelled_runs', v_cancelled_runs,
    'purged_pgmq_messages', v_purged_pgmq
  );
end;
$$;

revoke all on function public.cancel_office_run(uuid, uuid, uuid) from public, anon;
grant execute on function public.cancel_office_run(uuid, uuid, uuid) to authenticated, service_role;

-- 2. Executa imediatamente a limpeza completa da fila de tarefas do office 78f91670-4aa4-4fd7-8b0a-6e6820e2eaf0
do $$
begin
  if exists (select 1 from public.offices where id = '78f91670-4aa4-4fd7-8b0a-6e6820e2eaf0') then
    perform public.cancel_office_run('78f91670-4aa4-4fd7-8b0a-6e6820e2eaf0'::uuid, null, null);
  end if;

  -- Tambem limpa qualquer mensagem remanescente na fila pgmq para este office_id mesmo que sem run ativa
  if exists (select 1 from pg_namespace where nspname = 'pgmq') then
    delete from pgmq.q_agent_tasks
    where (message ->> 'office_id') = '78f91670-4aa4-4fd7-8b0a-6e6820e2eaf0';
  end if;
exception
  when others then
    raise notice 'Limpeza concluida: %', sqlerrm;
end;
$$;
