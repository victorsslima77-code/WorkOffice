-- ==============================================================================
-- WorkOffice — Politica de Cache Compartilhado de Midia YouTube (`yt-cache/*`)
-- no bucket `shorts` do Supabase Storage (mantendo `<office_id>/*` 100% isolado por RLS)
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
