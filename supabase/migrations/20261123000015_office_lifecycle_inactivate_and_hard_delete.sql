-- ==============================================================================
-- Migration 15: Ciclo de Vida do Escritorio (Inativar / Reativar e Exclusao Total)
-- - set_office_active_state: inativa o escritorio bloqueando gasto de tokens de
--   todos os agentes e preservando 100% do historico, ou reativa novamente.
-- - delete_office_completely: apaga TUDO relacionado ao escritorio no Supabase
--   (pgmq, Vault da integracao, Storage shorts/artifacts, metricas, artefatos,
--   llm_calls, eventos, tasks, runs, integracoes, agentes e o proprio escritorio).
-- ==============================================================================

create or replace function public.set_office_active_state(
  p_office_id uuid,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_owner_id uuid;
  v_office_name text;
  v_next_status text;
  v_msg record;
  v_purged_queue integer := 0;
begin
  select owner_id, name
  into v_owner_id, v_office_name
  from public.offices
  where id = p_office_id;

  if v_owner_id is null or v_owner_id <> auth.uid() then
    raise exception 'Escritório não encontrado ou acesso negado.';
  end if;

  if p_active then
    v_next_status := 'active';

    update public.offices
    set status = 'active'
    where id = p_office_id;

    update public.agents
    set status = 'idle'
    where office_id = p_office_id
      and status in ('paused_budget', 'error');

    insert into public.agent_events (office_id, agent_id, task_id, type, payload)
    select
      p_office_id,
      a.id,
      null,
      'agent.idle',
      jsonb_build_object(
        'message',
        format('Escritório "%s" reativado pelo usuário! %s está liberado para novas tarefas.', v_office_name, a.name)
      )
    from public.agents a
    where a.office_id = p_office_id;
  else
    v_next_status := 'paused';

    update public.offices
    set status = 'paused'
    where id = p_office_id;

    -- Bloqueia todos os agentes do escritorio para nao consumirem novos tokens
    update public.agents
    set status = 'paused_budget'
    where office_id = p_office_id;

    -- Cancela runs/tasks pendentes ou em execucao mantendo todo o historico
    update public.runs
    set
      status = 'cancelled',
      finished_at = coalesce(finished_at, now())
    where office_id = p_office_id
      and status in ('queued', 'running');

    update public.tasks t
    set
      status = 'cancelled',
      error_message = coalesce(error_message, 'Escritório inativado pelo usuário.'),
      finished_at = coalesce(finished_at, now())
    from public.runs r
    where t.run_id = r.id
      and r.office_id = p_office_id
      and t.status in ('queued', 'running');

    -- Remove mensagens pendentes da fila pgmq para este escritorio
    begin
      for v_msg in
        select msg_id
        from pgmq.q_agent_tasks
        where (message ->> 'office_id') = p_office_id::text
      loop
        perform pgmq.delete('agent_tasks', v_msg.msg_id);
        v_purged_queue := v_purged_queue + 1;
      end loop;
    exception
      when others then
        null;
    end;

    insert into public.agent_events (office_id, agent_id, task_id, type, payload)
    select
      p_office_id,
      a.id,
      null,
      'budget.exceeded',
      jsonb_build_object(
        'message',
        format('Escritório "%s" inativado pelo usuário! %s foi bloqueado contra gastos de tokens (histórico preservado).', v_office_name, a.name)
      )
    from public.agents a
    where a.office_id = p_office_id;
  end if;

  return jsonb_build_object(
    'office_id', p_office_id,
    'status', v_next_status,
    'purged_queue_messages', v_purged_queue
  );
end;
$$;

revoke all on function public.set_office_active_state(uuid, boolean) from public, anon;
grant execute on function public.set_office_active_state(uuid, boolean) to authenticated, service_role;

create or replace function public.delete_office_completely(
  p_office_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, storage, pgmq
as $$
declare
  v_owner_id uuid;
  v_office_name text;
  v_vault_ids uuid[];
  v_msg record;
  v_purged_queue integer := 0;
  v_deleted_storage integer := 0;
  v_deleted_vault integer := 0;
begin
  select owner_id, name
  into v_owner_id, v_office_name
  from public.offices
  where id = p_office_id;

  if v_owner_id is null or v_owner_id <> auth.uid() then
    raise exception 'Escritório não encontrado ou acesso negado.';
  end if;

  -- 1. Limpa todas as mensagens da fila pgmq relacionadas ao escritorio
  begin
    for v_msg in
      select msg_id
      from pgmq.q_agent_tasks
      where (message ->> 'office_id') = p_office_id::text
    loop
      perform pgmq.delete('agent_tasks', v_msg.msg_id);
      v_purged_queue := v_purged_queue + 1;
    end loop;
  exception
    when others then
      null;
  end;

  -- 2. Coleta os vault_secret_id das integracoes exclusivas deste escritorio (ex: YouTube OAuth)
  select coalesce(array_agg(vault_secret_id), '{}'::uuid[])
  into v_vault_ids
  from public.office_integrations
  where office_id = p_office_id;

  -- 3. Remove objetos do Supabase Storage pertencentes a este escritorio (<office_id>/...)
  begin
    delete from storage.objects
    where bucket_id in ('shorts', 'artifacts')
      and (
        (storage.foldername(name))[1] = p_office_id::text
        or name like p_office_id::text || '/%'
      );
    get diagnostics v_deleted_storage = row_count;
  exception
    when others then
      v_deleted_storage := 0;
  end;

  -- 4. Apaga registros relacionais respeitando todas as FKs (incluindo tasks.agent_id sem cascade)
  delete from public.video_metrics vm
  using public.artifacts ar, public.runs r
  where vm.artifact_id = ar.id
    and ar.run_id = r.id
    and r.office_id = p_office_id;

  delete from public.artifacts ar
  using public.runs r
  where ar.run_id = r.id
    and r.office_id = p_office_id;

  delete from public.llm_calls lc
  using public.agents a
  where lc.agent_id = a.id
    and a.office_id = p_office_id;

  delete from public.agent_events
  where office_id = p_office_id;

  delete from public.tasks t
  using public.runs r
  where t.run_id = r.id
    and r.office_id = p_office_id;

  delete from public.tasks t
  using public.agents a
  where t.agent_id = a.id
    and a.office_id = p_office_id;

  delete from public.runs
  where office_id = p_office_id;

  delete from public.office_integrations
  where office_id = p_office_id;

  delete from public.agents
  where office_id = p_office_id;

  delete from public.offices
  where id = p_office_id
    and owner_id = auth.uid();

  -- 5. Apaga os segredos do Vault exclusivos das integracoes deste escritorio
  if array_length(v_vault_ids, 1) is not null then
    begin
      delete from vault.secrets
      where id = any(v_vault_ids);
      get diagnostics v_deleted_vault = row_count;
    exception
      when others then
        v_deleted_vault := 0;
    end;
  end if;

  return jsonb_build_object(
    'deleted', true,
    'office_id', p_office_id,
    'office_name', v_office_name,
    'purged_queue_messages', v_purged_queue,
    'deleted_storage_objects', v_deleted_storage,
    'deleted_vault_secrets', v_deleted_vault
  );
end;
$$;

revoke all on function public.delete_office_completely(uuid) from public, anon;
grant execute on function public.delete_office_completely(uuid) to authenticated, service_role;
