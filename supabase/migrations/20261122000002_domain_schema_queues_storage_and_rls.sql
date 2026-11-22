-- ==============================================================================
-- Etapa 2: Modelo de Dados Completo, Vault, Fila (pgmq), Realtime e Storage RLS
-- Projeto Supabase alvo: jphdogyddahozpcgktdz
-- ==============================================================================

-- 1. Extensoes necessarias (Vault e pgmq)
create extension if not exists "pgcrypto";

do $$
begin
  create extension if not exists "supabase_vault" with schema "vault";
exception
  when others then
    raise notice 'Extensao supabase_vault ja configurada ou indisponivel: %', sqlerrm;
end;
$$;

do $$
begin
  create extension if not exists "pgmq";
  if not exists (
    select 1
    from pgmq.list_queues()
    where queue_name = 'agent_tasks'
  ) then
    perform pgmq.create('agent_tasks');
  end if;
exception
  when others then
    raise notice 'Fila pgmq agent_tasks sera inicializada quando pgmq estiver disponivel: %', sqlerrm;
end;
$$;

-- 2. Tabelas de Catalogo (Modelos de Escritorio, Cargos e Fluxos DAG)
create table if not exists public.office_templates (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text not null,
  rooms jsonb not null,
  map_config jsonb not null,
  max_agents integer not null check (max_agents > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.office_templates(id) on delete cascade,
  slug text not null,
  name text not null,
  scope text not null,
  input_schema jsonb not null,
  output_schema jsonb not null,
  default_effort text not null check (default_effort in ('low', 'medium', 'high')),
  allowed_tools text[] not null default '{}',
  system_prompt text not null,
  workstation_type text not null,
  created_at timestamptz not null default now(),
  unique (template_id, slug)
);

create table if not exists public.workflow_definitions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.office_templates(id) on delete cascade,
  version integer not null default 1,
  steps jsonb not null,
  created_at timestamptz not null default now(),
  unique (template_id, version)
);

-- 3. Tabelas de Instancia do Usuario (Offices, Credentials, Agents, Integrations)
create table if not exists public.offices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  template_id uuid not null references public.office_templates(id),
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists on_offices_updated on public.offices;
create trigger on_offices_updated
  before update on public.offices
  for each row
  execute function public.handle_updated_at();

create table if not exists public.agent_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'google', 'openai')),
  label text not null,
  vault_secret_id uuid not null,
  last4 text not null check (char_length(last4) <= 8),
  created_at timestamptz not null default now()
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  role_id uuid not null references public.roles(id),
  name text not null,
  sprite_key text not null,
  provider text not null check (provider in ('anthropic', 'google', 'openai')),
  model text not null,
  effort text not null check (effort in ('low', 'medium', 'high')),
  credential_id uuid not null references public.agent_credentials(id),
  desk_slot text not null,
  monthly_token_budget bigint check (monthly_token_budget is null or monthly_token_budget > 0),
  status text not null default 'idle' check (status in ('idle', 'working', 'paused_budget', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (office_id, desk_slot),
  unique (office_id, role_id)
);

drop trigger if exists on_agents_updated on public.agents;
create trigger on_agents_updated
  before update on public.agents
  for each row
  execute function public.handle_updated_at();

create table if not exists public.office_integrations (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  provider text not null check (provider in ('youtube')),
  vault_secret_id uuid not null,
  channel_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (office_id, provider)
);

-- 4. Tabelas de Execucao e Observabilidade (Runs, Tasks, Events, LLM Calls, Artifacts, Metrics)
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  input jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz,
  finished_at timestamptz,
  total_tokens bigint not null default 0,
  total_cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  agent_id uuid not null references public.agents(id),
  role_id uuid not null references public.roles(id),
  input jsonb not null,
  output jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  attempts integer not null default 0,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_events (
  id bigserial primary key,
  office_id uuid not null references public.offices(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.llm_calls (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  provider text not null,
  model text not null,
  effort text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  latency_ms integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  kind text not null check (kind in ('research_brief', 'raw_clip', 'edited_short', 'subtitle_srt', 'publish_report')),
  storage_path text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.video_metrics (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  youtube_video_id text not null,
  views bigint not null default 0,
  likes bigint not null default 0,
  comments bigint not null default 0,
  retention numeric(5, 2),
  captured_at timestamptz not null default now()
);

-- 5. Indices para Performance e Filtros de RLS
create index if not exists idx_roles_template_id on public.roles(template_id);
create index if not exists idx_offices_owner_id on public.offices(owner_id);
create index if not exists idx_agent_credentials_owner_id on public.agent_credentials(owner_id);
create index if not exists idx_agents_office_id on public.agents(office_id);
create index if not exists idx_office_integrations_office_id on public.office_integrations(office_id);
create index if not exists idx_runs_office_id on public.runs(office_id, created_at desc);
create index if not exists idx_tasks_run_id on public.tasks(run_id);
create index if not exists idx_tasks_agent_id on public.tasks(agent_id);
create index if not exists idx_agent_events_office_created on public.agent_events(office_id, created_at desc);
create index if not exists idx_agent_events_agent_id on public.agent_events(agent_id);
create index if not exists idx_llm_calls_task_id on public.llm_calls(task_id);
create index if not exists idx_llm_calls_agent_id on public.llm_calls(agent_id, created_at desc);
create index if not exists idx_artifacts_run_id on public.artifacts(run_id);
create index if not exists idx_video_metrics_artifact_id on public.video_metrics(artifact_id, captured_at desc);

-- 6. Funcao auxiliar para verificar propriedade do escritorio (evita recursao em RLS)
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
      and owner_id = auth.uid()
  );
$$;

-- 7. Row Level Security (RLS) em todas as tabelas
alter table public.office_templates enable row level security;
alter table public.office_templates force row level security;

alter table public.roles enable row level security;
alter table public.roles force row level security;

alter table public.workflow_definitions enable row level security;
alter table public.workflow_definitions force row level security;

alter table public.offices enable row level security;
alter table public.offices force row level security;

alter table public.agent_credentials enable row level security;
alter table public.agent_credentials force row level security;

alter table public.agents enable row level security;
alter table public.agents force row level security;

alter table public.office_integrations enable row level security;
alter table public.office_integrations force row level security;

alter table public.runs enable row level security;
alter table public.runs force row level security;

alter table public.tasks enable row level security;
alter table public.tasks force row level security;

alter table public.agent_events enable row level security;
alter table public.agent_events force row level security;

alter table public.llm_calls enable row level security;
alter table public.llm_calls force row level security;

alter table public.artifacts enable row level security;
alter table public.artifacts force row level security;

alter table public.video_metrics enable row level security;
alter table public.video_metrics force row level security;

-- Catalogos: leitura publica para usuarios autenticados
drop policy if exists "office_templates_select_all" on public.office_templates;
create policy "office_templates_select_all"
  on public.office_templates for select to authenticated, anon using (true);

drop policy if exists "roles_select_all" on public.roles;
create policy "roles_select_all"
  on public.roles for select to authenticated, anon using (true);

drop policy if exists "workflow_definitions_select_all" on public.workflow_definitions;
create policy "workflow_definitions_select_all"
  on public.workflow_definitions for select to authenticated, anon using (true);

-- Offices: somente o proprietario (owner_id = auth.uid())
drop policy if exists "offices_select_own" on public.offices;
create policy "offices_select_own"
  on public.offices for select to authenticated using (owner_id = auth.uid());

drop policy if exists "offices_insert_own" on public.offices;
create policy "offices_insert_own"
  on public.offices for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists "offices_update_own" on public.offices;
create policy "offices_update_own"
  on public.offices for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "offices_delete_own" on public.offices;
create policy "offices_delete_own"
  on public.offices for delete to authenticated using (owner_id = auth.uid());

-- Agent Credentials: somente o proprietario (owner_id = auth.uid())
drop policy if exists "agent_credentials_select_own" on public.agent_credentials;
create policy "agent_credentials_select_own"
  on public.agent_credentials for select to authenticated using (owner_id = auth.uid());

drop policy if exists "agent_credentials_insert_own" on public.agent_credentials;
create policy "agent_credentials_insert_own"
  on public.agent_credentials for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists "agent_credentials_update_own" on public.agent_credentials;
create policy "agent_credentials_update_own"
  on public.agent_credentials for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "agent_credentials_delete_own" on public.agent_credentials;
create policy "agent_credentials_delete_own"
  on public.agent_credentials for delete to authenticated using (owner_id = auth.uid());

-- Agents: isolados por user_owns_office(office_id)
drop policy if exists "agents_select_own" on public.agents;
create policy "agents_select_own"
  on public.agents for select to authenticated using (public.user_owns_office(office_id));

drop policy if exists "agents_insert_own" on public.agents;
create policy "agents_insert_own"
  on public.agents for insert to authenticated with check (public.user_owns_office(office_id));

drop policy if exists "agents_update_own" on public.agents;
create policy "agents_update_own"
  on public.agents for update to authenticated
  using (public.user_owns_office(office_id)) with check (public.user_owns_office(office_id));

drop policy if exists "agents_delete_own" on public.agents;
create policy "agents_delete_own"
  on public.agents for delete to authenticated using (public.user_owns_office(office_id));

-- Office Integrations: isoladas por user_owns_office(office_id)
drop policy if exists "office_integrations_select_own" on public.office_integrations;
create policy "office_integrations_select_own"
  on public.office_integrations for select to authenticated using (public.user_owns_office(office_id));

drop policy if exists "office_integrations_insert_own" on public.office_integrations;
create policy "office_integrations_insert_own"
  on public.office_integrations for insert to authenticated with check (public.user_owns_office(office_id));

drop policy if exists "office_integrations_update_own" on public.office_integrations;
create policy "office_integrations_update_own"
  on public.office_integrations for update to authenticated
  using (public.user_owns_office(office_id)) with check (public.user_owns_office(office_id));

drop policy if exists "office_integrations_delete_own" on public.office_integrations;
create policy "office_integrations_delete_own"
  on public.office_integrations for delete to authenticated using (public.user_owns_office(office_id));

-- Runs: isoladas por user_owns_office(office_id)
drop policy if exists "runs_select_own" on public.runs;
create policy "runs_select_own"
  on public.runs for select to authenticated using (public.user_owns_office(office_id));

drop policy if exists "runs_insert_own" on public.runs;
create policy "runs_insert_own"
  on public.runs for insert to authenticated with check (public.user_owns_office(office_id));

drop policy if exists "runs_update_own" on public.runs;
create policy "runs_update_own"
  on public.runs for update to authenticated
  using (public.user_owns_office(office_id)) with check (public.user_owns_office(office_id));

-- Tasks: isoladas via run -> office
drop policy if exists "tasks_select_own" on public.tasks;
create policy "tasks_select_own"
  on public.tasks for select to authenticated
  using (
    exists (
      select 1 from public.runs r
      where r.id = run_id and public.user_owns_office(r.office_id)
    )
  );

-- Agent Events: isolados por user_owns_office(office_id)
drop policy if exists "agent_events_select_own" on public.agent_events;
create policy "agent_events_select_own"
  on public.agent_events for select to authenticated using (public.user_owns_office(office_id));

-- LLM Calls: isoladas via agent -> office
drop policy if exists "llm_calls_select_own" on public.llm_calls;
create policy "llm_calls_select_own"
  on public.llm_calls for select to authenticated
  using (
    exists (
      select 1 from public.agents a
      where a.id = agent_id and public.user_owns_office(a.office_id)
    )
  );

-- Artifacts: isolados via run -> office
drop policy if exists "artifacts_select_own" on public.artifacts;
create policy "artifacts_select_own"
  on public.artifacts for select to authenticated
  using (
    exists (
      select 1 from public.runs r
      where r.id = run_id and public.user_owns_office(r.office_id)
    )
  );

-- Video Metrics: isoladas via artifact -> run -> office
drop policy if exists "video_metrics_select_own" on public.video_metrics;
create policy "video_metrics_select_own"
  on public.video_metrics for select to authenticated
  using (
    exists (
      select 1
      from public.artifacts ar
      join public.runs r on r.id = ar.run_id
      where ar.id = artifact_id and public.user_owns_office(r.office_id)
    )
  );

-- 8. Publicar agent_events (e runs/tasks) no Supabase Realtime de forma idempotente
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_events'
    ) then
      alter publication supabase_realtime add table public.agent_events;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'runs'
    ) then
      alter publication supabase_realtime add table public.runs;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
    ) then
      alter publication supabase_realtime add table public.tasks;
    end if;
  end if;
end;
$$;

-- 9. Buckets privados no Supabase Storage (artifacts, shorts) com RLS por office_id
insert into storage.buckets (id, name, public)
values
  ('artifacts', 'artifacts', false),
  ('shorts', 'shorts', false)
on conflict (id) do update
  set public = false;

-- Politicas em storage.objects: primeiro segmento do path = office_id (<office_id>/<run_id>/<filename>)
drop policy if exists "office_storage_select_own" on storage.objects;
create policy "office_storage_select_own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id in ('artifacts', 'shorts')
    and coalesce((storage.foldername(name))[1], '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.user_owns_office(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "office_storage_insert_own" on storage.objects;
create policy "office_storage_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id in ('artifacts', 'shorts')
    and coalesce((storage.foldername(name))[1], '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.user_owns_office(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "office_storage_update_own" on storage.objects;
create policy "office_storage_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id in ('artifacts', 'shorts')
    and coalesce((storage.foldername(name))[1], '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.user_owns_office(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id in ('artifacts', 'shorts')
    and coalesce((storage.foldername(name))[1], '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.user_owns_office(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "office_storage_delete_own" on storage.objects;
create policy "office_storage_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id in ('artifacts', 'shorts')
    and coalesce((storage.foldername(name))[1], '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.user_owns_office(((storage.foldername(name))[1])::uuid)
  );
