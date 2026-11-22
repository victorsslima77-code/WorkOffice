import {
  buildRateLimitHeaders,
  globalRateLimiter,
  MaskedCredentialSchema,
  RotateCredentialInputSchema,
  StoreCredentialInputSchema,
  type LlmProvider,
} from '@workoffice/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { verifyProviderApiKey } from '@/lib/credentials/verify-provider-key';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('agent_credentials')
    .select('id, provider, label, last4, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const masked = (data ?? []).map((item) => MaskedCredentialSchema.parse(item));
  return NextResponse.json({ credentials: masked });
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const rateDecision = globalRateLimiter.check('store-credential', user.id);
  const rateHeaders = buildRateLimitHeaders(rateDecision);
  if (!rateDecision.allowed) {
    return NextResponse.json(
      {
        error: `Muitas tentativas de gerenciamento de credenciais (${rateDecision.limit}/min). Aguarde ${rateDecision.retryAfterSec}s.`,
      },
      { status: 429, headers: rateHeaders },
    );
  }

  const body = await request.json();
  const parsed = StoreCredentialInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' },
      { status: 400 },
    );
  }

  const check = await verifyProviderApiKey(parsed.data.provider, parsed.data.apiKey);
  if (!check.valid) {
    return NextResponse.json(
      { error: check.reason ?? 'Chave de API rejeitada pelo provedor.' },
      { status: 422 },
    );
  }

  const { data, error } = await supabase.rpc('store_user_agent_credential', {
    p_provider: parsed.data.provider,
    p_label: parsed.data.label,
    p_api_key: parsed.data.apiKey,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const masked = MaskedCredentialSchema.parse(data);
  return NextResponse.json({ credential: masked }, { status: 201, headers: rateHeaders });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const rateDecision = globalRateLimiter.check('store-credential', user.id);
  const rateHeaders = buildRateLimitHeaders(rateDecision);
  if (!rateDecision.allowed) {
    return NextResponse.json(
      {
        error: `Muitas tentativas de gerenciamento de credenciais (${rateDecision.limit}/min). Aguarde ${rateDecision.retryAfterSec}s.`,
      },
      { status: 429, headers: rateHeaders },
    );
  }

  const body = await request.json();
  const parsed = RotateCredentialInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' },
      { status: 400 },
    );
  }

  const { data: existing, error: fetchErr } = await supabase
    .from('agent_credentials')
    .select('id, provider')
    .eq('id', parsed.data.credentialId)
    .maybeSingle();

  if (fetchErr || !existing) {
    return NextResponse.json({ error: 'Credencial não encontrada.' }, { status: 404 });
  }

  const check = await verifyProviderApiKey(
    existing.provider as LlmProvider,
    parsed.data.newApiKey,
  );
  if (!check.valid) {
    return NextResponse.json(
      { error: check.reason ?? 'Nova chave rejeitada pelo provedor.' },
      { status: 422 },
    );
  }

  const { data, error } = await supabase.rpc('rotate_user_agent_credential', {
    p_credential_id: parsed.data.credentialId,
    p_new_api_key: parsed.data.newApiKey,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const masked = MaskedCredentialSchema.parse(data);
  return NextResponse.json({ credential: masked });
}

export async function DELETE(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const credentialId = searchParams.get('id');
  if (!credentialId) {
    return NextResponse.json({ error: 'Informe o ID da credencial.' }, { status: 400 });
  }

  const { error } = await supabase.rpc('revoke_user_agent_credential', {
    p_credential_id: credentialId,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ revoked: true });
}
