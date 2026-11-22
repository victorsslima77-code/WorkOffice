-- ==============================================================================
-- Etapa 3: Cofre de Chaves (Supabase Vault RPCs) para Criacao, Rotacao e Revogacao
-- Projeto Supabase alvo: jphdogyddahozpcgktdz
-- ==============================================================================

-- 1. Armazena uma nova chave de API no Supabase Vault e grava apenas metadados mascarados
create or replace function public.store_user_agent_credential(
  p_provider text,
  p_label text,
  p_api_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid;
  v_clean_key text;
  v_clean_label text;
  v_last4 text;
  v_vault_id uuid;
  v_cred_id uuid;
  v_created_at timestamptz;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario nao autenticado.' using errcode = '42501';
  end if;

  if p_provider not in ('anthropic', 'google', 'openai') then
    raise exception 'Provedor invalido: %', p_provider using errcode = '22023';
  end if;

  v_clean_key := trim(coalesce(p_api_key, ''));
  if char_length(v_clean_key) < 8 then
    raise exception 'A chave de API deve ter pelo menos 8 caracteres.' using errcode = '22023';
  end if;

  v_clean_label := trim(coalesce(p_label, ''));
  if char_length(v_clean_label) < 2 then
    raise exception 'Informe um rotulo com pelo menos 2 caracteres.' using errcode = '22023';
  end if;

  v_last4 := right(v_clean_key, 4);

  -- Grava o segredo criptografado no Supabase Vault
  v_vault_id := vault.create_secret(
    v_clean_key,
    'workoffice_cred_' || v_user_id::text || '_' || gen_random_uuid()::text,
    'Chave BYOK (' || p_provider || ') do usuario ' || v_user_id::text
  );

  insert into public.agent_credentials (
    owner_id,
    provider,
    label,
    vault_secret_id,
    last4
  )
  values (
    v_user_id,
    p_provider,
    v_clean_label,
    v_vault_id,
    v_last4
  )
  returning id, created_at into v_cred_id, v_created_at;

  return jsonb_build_object(
    'id', v_cred_id,
    'provider', p_provider,
    'label', v_clean_label,
    'last4', v_last4,
    'created_at', v_created_at
  );
end;
$$;

revoke all on function public.store_user_agent_credential(text, text, text) from public, anon;
grant execute on function public.store_user_agent_credential(text, text, text) to authenticated, service_role;

-- 2. Rotaciona (substitui) o valor da chave de API no Vault mantendo o mesmo credential_id
create or replace function public.rotate_user_agent_credential(
  p_credential_id uuid,
  p_new_api_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid;
  v_clean_key text;
  v_last4 text;
  v_record public.agent_credentials%rowtype;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario nao autenticado.' using errcode = '42501';
  end if;

  v_clean_key := trim(coalesce(p_new_api_key, ''));
  if char_length(v_clean_key) < 8 then
    raise exception 'A nova chave de API deve ter pelo menos 8 caracteres.' using errcode = '22023';
  end if;

  select *
  into v_record
  from public.agent_credentials
  where id = p_credential_id
    and owner_id = v_user_id;

  if not found then
    raise exception 'Credencial nao encontrada ou sem permissao.' using errcode = '42501';
  end if;

  v_last4 := right(v_clean_key, 4);

  perform vault.update_secret(
    v_record.vault_secret_id,
    v_clean_key,
    'workoffice_cred_' || v_user_id::text || '_' || v_record.id::text,
    'Chave BYOK rotacionada (' || v_record.provider || ')'
  );

  update public.agent_credentials
  set last4 = v_last4
  where id = p_credential_id
    and owner_id = v_user_id;

  return jsonb_build_object(
    'id', v_record.id,
    'provider', v_record.provider,
    'label', v_record.label,
    'last4', v_last4,
    'created_at', v_record.created_at
  );
end;
$$;

revoke all on function public.rotate_user_agent_credential(uuid, text) from public, anon;
grant execute on function public.rotate_user_agent_credential(uuid, text) to authenticated, service_role;

-- 3. Revoga e exclui uma credencial e seu respectivo segredo no Vault
create or replace function public.revoke_user_agent_credential(
  p_credential_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid;
  v_vault_id uuid;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario nao autenticado.' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.agents
    where credential_id = p_credential_id
  ) then
    raise exception 'Esta credencial esta vinculada a um agente ativo. Altere a credencial do agente antes de revoga-la.'
      using errcode = '23503';
  end if;

  delete from public.agent_credentials
  where id = p_credential_id
    and owner_id = v_user_id
  returning vault_secret_id into v_vault_id;

  if v_vault_id is null then
    raise exception 'Credencial nao encontrada ou sem permissao.' using errcode = '42501';
  end if;

  delete from vault.secrets
  where id = v_vault_id;

  return true;
end;
$$;

revoke all on function public.revoke_user_agent_credential(uuid) from public, anon;
grant execute on function public.revoke_user_agent_credential(uuid) to authenticated, service_role;

-- 4. RPC restrita ao Worker (service_role) para descriptografar a chave em memoria na execucao
create or replace function public.get_agent_secret_for_worker(
  p_agent_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  select ds.decrypted_secret
  into v_secret
  from public.agents a
  join public.agent_credentials ac on ac.id = a.credential_id
  join vault.decrypted_secrets ds on ds.id = ac.vault_secret_id
  where a.id = p_agent_id;

  if v_secret is null then
    raise exception 'Segredo nao encontrado para o agente %', p_agent_id;
  end if;

  return v_secret;
end;
$$;

revoke all on function public.get_agent_secret_for_worker(uuid) from public, anon, authenticated;
grant execute on function public.get_agent_secret_for_worker(uuid) to service_role;
