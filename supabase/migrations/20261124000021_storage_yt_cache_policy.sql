-- ==============================================================================
-- WorkOffice — Politica de Cache Compartilhado de Midia YouTube (`yt-cache/*`)
-- no bucket `shorts` do Supabase Storage (mantendo `<office_id>/*` 100% isolado por RLS)
-- + Atualizacao automatica de IDs legados da Anthropic em `public.agents`
-- ==============================================================================

drop policy if exists "storage_objects_yt_cache_select" on storage.objects;
create policy "storage_objects_yt_cache_select"
  on storage.objects for select
  using (
    bucket_id = 'shorts'
    and (storage.foldername(name))[1] = 'yt-cache'
  );

drop policy if exists "storage_objects_yt_cache_insert" on storage.objects;
create policy "storage_objects_yt_cache_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'shorts'
    and (storage.foldername(name))[1] = 'yt-cache'
  );

drop policy if exists "storage_objects_yt_cache_update" on storage.objects;
create policy "storage_objects_yt_cache_update"
  on storage.objects for update
  using (
    bucket_id = 'shorts'
    and (storage.foldername(name))[1] = 'yt-cache'
  )
  with check (
    bucket_id = 'shorts'
    and (storage.foldername(name))[1] = 'yt-cache'
  );

-- Migra agentes existentes configurados com IDs descontinuados da Anthropic para os modelos ativos,
-- eliminando o aviso HTTP 404 antes do fallback automatico no Worker.
update public.agents
set model = 'claude-sonnet-4-6'
where provider = 'anthropic'
  and model = 'claude-sonnet-4-20250514';

update public.agents
set model = 'claude-haiku-4-5-20251001'
where provider = 'anthropic'
  and model = 'claude-3-5-haiku-latest';
