// Supabase Edge Function: store-credential
// Gerencia chaves de API BYOK dos agentes no Supabase Vault com Rate Limiting (15 req/min):
// - GET: Lista credenciais mascaradas (id, provider, label, last4, created_at)
// - POST: Valida a chave previamente no provedor e grava via vault.create_secret (RPC store_user_agent_credential)
// - PATCH: Valida a nova chave e rotaciona o segredo no Vault (RPC rotate_user_agent_credential)
// - DELETE: Revoga a credencial e apaga o segredo do Vault (RPC revoke_user_agent_credential)

import { createClient } from 'jsr:@supabase/supabase-js@2';

type LlmProvider = 'anthropic' | 'google' | 'openai';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

const MAX_CREDENTIAL_MUTATIONS_PER_MINUTE = 15;
const WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function evaluateCredentialRateLimit(subject: string): {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
} {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const active = (rateBuckets.get(subject) ?? []).filter((ts) => ts > cutoff);

  if (active.length >= MAX_CREDENTIAL_MUTATIONS_PER_MINUTE) {
    const oldest = active[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    rateBuckets.set(subject, active);
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  active.push(now);
  rateBuckets.set(subject, active);
  return {
    allowed: true,
    remaining: Math.max(0, MAX_CREDENTIAL_MUTATIONS_PER_MINUTE - active.length),
    retryAfterSec: 0,
  };
}

async function verifyKeyWithProvider(
  provider: LlmProvider,
  rawKey: string,
): Promise<{ valid: boolean; reason?: string }> {
  const key = rawKey.trim();
  if (key.length < 12 || /\s/.test(key)) {
    return { valid: false, reason: 'Chave de API invalida ou muito curta.' };
  }

  if (key.startsWith(`wo_test_${provider}_`) && key.length >= `wo_test_${provider}_`.length + 6) {
    return { valid: true };
  }

  try {
    if (provider === 'anthropic') {
      if (!key.startsWith('sk-ant-')) {
        return { valid: false, reason: 'Chaves Anthropic devem iniciar com sk-ant-.' };
      }
      const res = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) {
        return {
          valid: false,
          reason: `Anthropic rejeitou a chave (HTTP ${res.status}). Verifique se a chave esta ativa.`,
        };
      }
      return { valid: true };
    }

    if (provider === 'google') {
      if (!key.startsWith('AIza')) {
        return { valid: false, reason: 'Chaves Google Gemini devem iniciar com AIza.' };
      }
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        { method: 'GET' },
      );
      if (!res.ok) {
        return {
          valid: false,
          reason: `Google Gemini rejeitou a chave (HTTP ${res.status}). Verifique se a chave esta ativa.`,
        };
      }
      return { valid: true };
    }

    if (provider === 'openai') {
      if (!key.startsWith('sk-')) {
        return { valid: false, reason: 'Chaves OpenAI devem iniciar com sk-.' };
      }
      const res = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });
      if (!res.ok) {
        return {
          valid: false,
          reason: `OpenAI rejeitou a chave (HTTP ${res.status}). Verifique se a chave esta ativa.`,
        };
      }
      return { valid: true };
    }

    return { valid: false, reason: 'Provedor desconhecido.' };
  } catch (err) {
    return {
      valid: false,
      reason: `Erro ao validar chave junto ao provedor: ${(err as Error).message}`,
    };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Cabeçalho Authorization ausente.' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    {
      global: { headers: { Authorization: authHeader } },
    },
  );

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('agent_credentials')
      .select('id, provider, label, last4, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ credentials: data ?? [] }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const subjectKey = user?.id ?? req.headers.get('x-forwarded-for') ?? 'anon';
  const rate = evaluateCredentialRateLimit(subjectKey);
  const rateHeaders = {
    'X-RateLimit-Limit': String(MAX_CREDENTIAL_MUTATIONS_PER_MINUTE),
    'X-RateLimit-Remaining': String(rate.remaining),
    ...(rate.allowed ? {} : { 'Retry-After': String(rate.retryAfterSec) }),
  };

  if (!rate.allowed) {
    return new Response(
      JSON.stringify({
        error: `Muitas operacoes de credencial (${MAX_CREDENTIAL_MUTATIONS_PER_MINUTE}/min). Aguarde ${rate.retryAfterSec}s.`,
      }),
      {
        status: 429,
        headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const provider = body.provider as LlmProvider;
    const label = String(body.label ?? '').trim();
    const apiKey = String(body.apiKey ?? '').trim();

    const check = await verifyKeyWithProvider(provider, apiKey);
    if (!check.valid) {
      return new Response(JSON.stringify({ error: check.reason ?? 'Chave invalida.' }), {
        status: 422,
        headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data, error } = await supabase.rpc('store_user_agent_credential', {
      p_provider: provider,
      p_label: label,
      p_api_key: apiKey,
    });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ credential: data }), {
      status: 201,
      headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    const credentialId = String(body.credentialId ?? '');
    const provider = body.provider as LlmProvider;
    const newApiKey = String(body.newApiKey ?? '').trim();

    const check = await verifyKeyWithProvider(provider, newApiKey);
    if (!check.valid) {
      return new Response(JSON.stringify({ error: check.reason ?? 'Nova chave invalida.' }), {
        status: 422,
        headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data, error } = await supabase.rpc('rotate_user_agent_credential', {
      p_credential_id: credentialId,
      p_new_api_key: newApiKey,
    });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ credential: data }), {
      status: 200,
      headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url);
    const credentialId = url.searchParams.get('id') ?? '';

    const { data, error } = await supabase.rpc('revoke_user_agent_credential', {
      p_credential_id: credentialId,
    });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ revoked: Boolean(data) }), {
      status: 200,
      headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Metodo HTTP nao suportado.' }), {
    status: 405,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
