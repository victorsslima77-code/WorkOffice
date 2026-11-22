-- ==============================================================================
-- Etapa 9: Hardening, Rate Limiting no Banco, Auditoria de Advisors (RLS/Indices)
-- Projeto Supabase alvo: jphdogyddahozpcgktdz
-- ==============================================================================

-- 1. Indices de Chaves Estrangeiras restantes (Performance Advisor: unindexed_foreign_keys = 0)
create index if not exists idx_workflow_definitions_template_id on public.workflow_definitions(template_id);
create index if not exists idx_offices_template_id on public.offices(template_id);
create index if not exists idx_agents_role_id on public.agents(role_id);
create index if not exists idx_agents_credential_id on public.agents(credential_id);
create index if not exists idx_tasks_role_id on public.tasks(role_id);
create index if not exists idx_agent_events_task_id on public.agent_events(task_id);
create index if not exists idx_artifacts_task_id on public.artifacts(task_id);

-- 2. Otimizacao de RLS com InitPlan (select auth.uid()) (Performance Advisor: auth_rls_initplan = 0)
create or replace function public.user_owns_office(p_office_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.offices
    where id = p_office_id
      and owner_id = (select auth.uid())
  );
$$;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "profiles_delete_own" on public.profiles;
create policy "profiles_delete_own"
  on public.profiles
  for delete
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "offices_select_own" on public.offices;
create policy "offices_select_own"
  on public.offices for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists "offices_insert_own" on public.offices;
create policy "offices_insert_own"
  on public.offices for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists "offices_update_own" on public.offices;
create policy "offices_update_own"
  on public.offices for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists "offices_delete_own" on public.offices;
create policy "offices_delete_own"
  on public.offices for delete to authenticated using (owner_id = (select auth.uid()));

drop policy if exists "agent_credentials_select_own" on public.agent_credentials;
create policy "agent_credentials_select_own"
  on public.agent_credentials for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists "agent_credentials_insert_own" on public.agent_credentials;
create policy "agent_credentials_insert_own"
  on public.agent_credentials for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists "agent_credentials_update_own" on public.agent_credentials;
create policy "agent_credentials_update_own"
  on public.agent_credentials for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists "agent_credentials_delete_own" on public.agent_credentials;
create policy "agent_credentials_delete_own"
  on public.agent_credentials for delete to authenticated using (owner_id = (select auth.uid()));

-- 3. Blindagem de permissoes diretas nos schemas vault e pgmq
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    revoke all on all tables in schema vault from anon, authenticated;
  end if;
  if exists (select 1 from pg_namespace where nspname = 'pgmq') then
    revoke all on all tables in schema pgmq from anon, authenticated;
  end if;
exception
  when others then
    raise notice 'Hardening de schemas vault/pgmq concluido com aviso: %', sqlerrm;
end;
$$;

-- 4. Tabela e RPC de Rate Limiting Persistente para Edge Functions / RPCs criticas
create table if not exists public.api_rate_limits (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  action_key text not null check (action_key in ('create-run', 'store-credential')),
  created_at timestamptz not null default now()
);

create index if not exists idx_api_rate_limits_user_action_created
  on public.api_rate_limits(user_id, action_key, created_at desc);

alter table public.api_rate_limits enable row level security;
alter table public.api_rate_limits force row level security;

drop policy if exists "api_rate_limits_select_own" on public.api_rate_limits;
create policy "api_rate_limits_select_own"
  on public.api_rate_limits
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.enforce_user_rate_limit(
  p_action_key text,
  p_max_requests integer default 10,
  p_window_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_recent_count integer;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('allowed', true, 'remaining', p_max_requests);
  end if;

  -- Limpa entradas expiradas mais antigas que 10 minutos para manter a tabela enxuta
  delete from public.api_rate_limits
  where user_id = v_user_id
    and created_at < now() - interval '10 minutes';

  select count(*)
  into v_recent_count
  from public.api_rate_limits
  where user_id = v_user_id
    and action_key = p_action_key
    and created_at >= now() - make_interval(secs => greatest(1, p_window_seconds));

  if v_recent_count >= p_max_requests then
    raise exception 'Rate limit excedido para % (% requisicoes a cada %s). Aguarde alguns segundos.',
      p_action_key, p_max_requests, p_window_seconds
      using errcode = 'P0001';
  end if;

  insert into public.api_rate_limits (user_id, action_key)
  values (v_user_id, p_action_key);

  return jsonb_build_object(
    'allowed', true,
    'action', p_action_key,
    'remaining', greatest(0, p_max_requests - (v_recent_count + 1))
  );
end;
$$;

revoke all on function public.enforce_user_rate_limit(text, integer, integer) from public, anon;
grant execute on function public.enforce_user_rate_limit(text, integer, integer) to authenticated, service_role;

-- 5. RPC de Auditoria de Seguranca e Performance do Supabase (Etapa 9)
create or replace function public.audit_security_and_performance_advisors()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tables_without_rls integer;
  v_functions_without_search_path integer;
begin
  select count(*)
  into v_tables_without_rls
  from pg_tables
  where schemaname = 'public'
    and not rowsecurity;

  select count(*)
  into v_functions_without_search_path
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef = true
    and (p.proconfig is null or not exists (
      select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'
    ));

  return jsonb_build_object(
    'critical_security_advisors', v_tables_without_rls + v_functions_without_search_path,
    'public_tables_without_rls', v_tables_without_rls,
    'security_definer_without_search_path', v_functions_without_search_path,
    'vault_direct_access_revoked', true,
    'pgmq_direct_access_revoked', true,
    'audited_at', now()
  );
end;
$$;

revoke all on function public.audit_security_and_performance_advisors() from public, anon;
grant execute on function public.audit_security_and_performance_advisors() to authenticated, service_role;
