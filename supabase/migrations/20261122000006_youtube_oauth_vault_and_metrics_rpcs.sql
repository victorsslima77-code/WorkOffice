-- ==============================================================================
-- Etapa 6: Integracao OAuth 2.0 do YouTube no Supabase Vault e Coleta de Metricas
-- Projeto Supabase alvo: jphdogyddahozpcgktdz
-- ==============================================================================

-- 1. Armazena ou atualiza o refresh_token OAuth do YouTube do escritorio no Supabase Vault
create or replace function public.store_office_youtube_integration(
  p_office_id uuid,
  p_refresh_token text,
  p_channel_id text,
  p_channel_title text default null,
  p_scopes text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_clean_token text;
  v_clean_channel text;
  v_existing public.office_integrations%rowtype;
  v_vault_id uuid;
  v_integration_id uuid;
  v_metadata jsonb;
begin
  if auth.uid() is not null and not public.user_owns_office(p_office_id) then
    raise exception 'Sem permissao para configurar integracao neste escritorio.' using errcode = '42501';
  end if;

  v_clean_token := trim(coalesce(p_refresh_token, ''));
  if char_length(v_clean_token) < 10 then
    raise exception 'Refresh token OAuth do YouTube invalido.' using errcode = '22023';
  end if;

  v_clean_channel := trim(coalesce(p_channel_id, ''));
  if char_length(v_clean_channel) < 3 then
    raise exception 'Informe um channel_id valido do YouTube.' using errcode = '22023';
  end if;

  v_metadata := jsonb_build_object(
    'channel_title', coalesce(nullif(trim(p_channel_title), ''), v_clean_channel),
    'scopes', to_jsonb(coalesce(p_scopes, array['youtube.upload', 'yt-analytics.readonly'])),
    'connected_at', now()
  );

  select *
  into v_existing
  from public.office_integrations
  where office_id = p_office_id
    and provider = 'youtube';

  if found then
    perform vault.update_secret(
      v_existing.vault_secret_id,
      v_clean_token,
      'workoffice_yt_oauth_' || p_office_id::text,
      'YouTube OAuth Refresh Token do escritorio ' || p_office_id::text
    );

    update public.office_integrations
    set
      channel_id = v_clean_channel,
      metadata = v_metadata
    where id = v_existing.id
    returning id into v_integration_id;
  else
    v_vault_id := vault.create_secret(
      v_clean_token,
      'workoffice_yt_oauth_' || p_office_id::text || '_' || gen_random_uuid()::text,
      'YouTube OAuth Refresh Token do escritorio ' || p_office_id::text
    );

    insert into public.office_integrations (
      office_id,
      provider,
      vault_secret_id,
      channel_id,
      metadata
    )
    values (
      p_office_id,
      'youtube',
      v_vault_id,
      v_clean_channel,
      v_metadata
    )
    returning id into v_integration_id;
  end if;

  return jsonb_build_object(
    'id', v_integration_id,
    'office_id', p_office_id,
    'provider', 'youtube',
    'channel_id', v_clean_channel,
    'metadata', v_metadata
  );
end;
$$;

revoke all on function public.store_office_youtube_integration(uuid, text, text, text, text[]) from public, anon;
grant execute on function public.store_office_youtube_integration(uuid, text, text, text, text[]) to authenticated, service_role;

-- 2. Revoga a integracao OAuth do YouTube e remove o refresh_token do Vault
create or replace function public.revoke_office_youtube_integration(
  p_office_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_vault_id uuid;
begin
  if auth.uid() is not null and not public.user_owns_office(p_office_id) then
    raise exception 'Sem permissao para remover integracao deste escritorio.' using errcode = '42501';
  end if;

  delete from public.office_integrations
  where office_id = p_office_id
    and provider = 'youtube'
  returning vault_secret_id into v_vault_id;

  if v_vault_id is not null then
    delete from vault.secrets
    where id = v_vault_id;
  end if;

  return v_vault_id is not null;
end;
$$;

revoke all on function public.revoke_office_youtube_integration(uuid) from public, anon;
grant execute on function public.revoke_office_youtube_integration(uuid) to authenticated, service_role;

-- 3. RPC restrita ao Worker (service_role) para obter o refresh_token OAuth descriptografado
create or replace function public.get_office_youtube_secret_for_worker(
  p_office_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'channel_id', oi.channel_id,
    'refresh_token', ds.decrypted_secret,
    'metadata', oi.metadata
  )
  into v_result
  from public.office_integrations oi
  join vault.decrypted_secrets ds on ds.id = oi.vault_secret_id
  where oi.office_id = p_office_id
    and oi.provider = 'youtube';

  return v_result;
end;
$$;

revoke all on function public.get_office_youtube_secret_for_worker(uuid) from public, anon, authenticated;
grant execute on function public.get_office_youtube_secret_for_worker(uuid) to service_role;

-- 4. RPC para o Worker registrar snapshots de metricas de Shorts publicados em video_metrics
create or replace function public.record_video_metric_snapshot(
  p_artifact_id uuid,
  p_youtube_video_id text,
  p_views bigint,
  p_likes bigint,
  p_comments bigint,
  p_retention numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_metric_id uuid;
begin
  insert into public.video_metrics (
    artifact_id,
    youtube_video_id,
    views,
    likes,
    comments,
    retention,
    captured_at
  )
  values (
    p_artifact_id,
    p_youtube_video_id,
    greatest(0, coalesce(p_views, 0)),
    greatest(0, coalesce(p_likes, 0)),
    greatest(0, coalesce(p_comments, 0)),
    p_retention,
    now()
  )
  returning id into v_metric_id;

  return v_metric_id;
end;
$$;

revoke all on function public.record_video_metric_snapshot(uuid, text, bigint, bigint, bigint, numeric) from public, anon;
grant execute on function public.record_video_metric_snapshot(uuid, text, bigint, bigint, bigint, numeric) to authenticated, service_role;
