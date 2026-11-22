-- ==============================================================================
-- Etapa 9.2: Encapsulamento Completo das Credenciais OAuth 2.0 do YouTube
-- (client_id, client_secret e refresh_token) no Cofre do Usuario (Supabase Vault)
-- Projeto Supabase alvo: jphdogyddahozpcgktdz
-- ==============================================================================

-- 1. Armazena o pacote OAuth 2.0 completo do usuario (client_id, client_secret, refresh_token)
-- criptografado no Supabase Vault, mantendo apenas metadados mascarados (last4) em office_integrations
create or replace function public.store_office_youtube_integration(
  p_office_id uuid,
  p_refresh_token text,
  p_channel_id text,
  p_channel_title text default null,
  p_scopes text[] default '{}',
  p_client_id text default null,
  p_client_secret text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_clean_token text;
  v_clean_channel text;
  v_clean_client_id text;
  v_clean_client_secret text;
  v_secret_payload text;
  v_existing public.office_integrations%rowtype;
  v_vault_id uuid;
  v_integration_id uuid;
  v_metadata jsonb;
begin
  if auth.uid() is not null and not public.user_owns_office(p_office_id) then
    raise exception 'Sem permissao para configurar integracao neste escritorio.' using errcode = '42501';
  end if;

  v_clean_token := trim(coalesce(p_refresh_token, ''));
  if char_length(v_clean_token) < 8 then
    raise exception 'Refresh token OAuth do YouTube invalido.' using errcode = '22023';
  end if;

  v_clean_channel := trim(coalesce(p_channel_id, ''));
  if char_length(v_clean_channel) < 3 then
    raise exception 'Informe um channel_id valido do YouTube.' using errcode = '22023';
  end if;

  v_clean_client_id := trim(coalesce(p_client_id, ''));
  v_clean_client_secret := trim(coalesce(p_client_secret, ''));

  -- Serializa client_id, client_secret e refresh_token juntos dentro do segredo criptografado no Vault
  v_secret_payload := jsonb_build_object(
    'client_id', v_clean_client_id,
    'client_secret', v_clean_client_secret,
    'refresh_token', v_clean_token
  )::text;

  v_metadata := jsonb_build_object(
    'channel_title', coalesce(nullif(trim(p_channel_title), ''), v_clean_channel),
    'client_id_last4', case when char_length(v_clean_client_id) >= 4 then right(v_clean_client_id, 4) else 'sandbox' end,
    'refresh_token_last4', right(v_clean_token, 4),
    'scopes', to_jsonb(coalesce(p_scopes, array['youtube.upload', 'yt-analytics.readonly'])),
    'encapsulated_in_user_vault', true,
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
      v_secret_payload,
      'workoffice_yt_oauth_' || p_office_id::text,
      'Credenciais OAuth 2.0 YouTube (client_id + client_secret + refresh_token) do escritorio ' || p_office_id::text
    );

    update public.office_integrations
    set
      channel_id = v_clean_channel,
      metadata = v_metadata
    where id = v_existing.id
    returning id into v_integration_id;
  else
    v_vault_id := vault.create_secret(
      v_secret_payload,
      'workoffice_yt_oauth_' || p_office_id::text || '_' || gen_random_uuid()::text,
      'Credenciais OAuth 2.0 YouTube (client_id + client_secret + refresh_token) do escritorio ' || p_office_id::text
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

revoke all on function public.store_office_youtube_integration(uuid, text, text, text, text[], text, text) from public, anon;
grant execute on function public.store_office_youtube_integration(uuid, text, text, text, text[], text, text) to authenticated, service_role;

-- 2. Atualiza get_office_youtube_secret_for_worker para extrair client_id, client_secret e refresh_token do Vault do usuario
create or replace function public.get_office_youtube_secret_for_worker(
  p_office_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_raw_secret text;
  v_channel_id text;
  v_metadata jsonb;
  v_parsed jsonb;
begin
  select
    oi.channel_id,
    oi.metadata,
    ds.decrypted_secret
  into
    v_channel_id,
    v_metadata,
    v_raw_secret
  from public.office_integrations oi
  join vault.decrypted_secrets ds on ds.id = oi.vault_secret_id
  where oi.office_id = p_office_id
    and oi.provider = 'youtube';

  if not found or v_raw_secret is null then
    return null;
  end if;

  begin
    v_parsed := v_raw_secret::jsonb;
  exception
    when others then
      v_parsed := jsonb_build_object(
        'client_id', '',
        'client_secret', '',
        'refresh_token', v_raw_secret
      );
  end;

  return jsonb_build_object(
    'channel_id', v_channel_id,
    'client_id', coalesce(v_parsed ->> 'client_id', ''),
    'client_secret', coalesce(v_parsed ->> 'client_secret', ''),
    'refresh_token', coalesce(v_parsed ->> 'refresh_token', v_raw_secret),
    'metadata', v_metadata
  );
end;
$$;

revoke all on function public.get_office_youtube_secret_for_worker(uuid) from public, anon, authenticated;
grant execute on function public.get_office_youtube_secret_for_worker(uuid) to service_role;

-- 3. RPC para o proprio dono do escritorio (no callback OAuth server-side) trocar o code usando o client_id/client_secret do seu Vault
create or replace function public.get_office_youtube_oauth_for_owner(
  p_office_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_raw_secret text;
  v_channel_id text;
  v_parsed jsonb;
begin
  if auth.uid() is null or not public.user_owns_office(p_office_id) then
    raise exception 'Sem permissao para ler credencial OAuth deste escritorio.' using errcode = '42501';
  end if;

  select
    oi.channel_id,
    ds.decrypted_secret
  into
    v_channel_id,
    v_raw_secret
  from public.office_integrations oi
  join vault.decrypted_secrets ds on ds.id = oi.vault_secret_id
  where oi.office_id = p_office_id
    and oi.provider = 'youtube';

  if not found or v_raw_secret is null then
    return null;
  end if;

  begin
    v_parsed := v_raw_secret::jsonb;
  exception
    when others then
      v_parsed := jsonb_build_object('client_id', '', 'client_secret', '', 'refresh_token', v_raw_secret);
  end;

  return jsonb_build_object(
    'channel_id', v_channel_id,
    'client_id', coalesce(v_parsed ->> 'client_id', ''),
    'client_secret', coalesce(v_parsed ->> 'client_secret', ''),
    'refresh_token', coalesce(v_parsed ->> 'refresh_token', '')
  );
end;
$$;

revoke all on function public.get_office_youtube_oauth_for_owner(uuid) from public, anon;
grant execute on function public.get_office_youtube_oauth_for_owner(uuid) to authenticated, service_role;
