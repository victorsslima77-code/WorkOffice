// Supabase Edge Function: create-run
// Dispara uma nova Run no escritorio, criando a Task #1 do Roteirista e enfileirando no pgmq,
// com Rate Limiting (10 runs / minuto por usuario ou IP).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_REQUESTS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function evaluateEdgeRateLimit(subject: string): {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
} {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const active = (rateBuckets.get(subject) ?? []).filter((ts) => ts > cutoff);

  if (active.length >= MAX_REQUESTS_PER_MINUTE) {
    const oldest = active[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    rateBuckets.set(subject, active);
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  active.push(now);
  rateBuckets.set(subject, active);
  return {
    allowed: true,
    remaining: Math.max(0, MAX_REQUESTS_PER_MINUTE - active.length),
    retryAfterSec: 0,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Authorization ausente.' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const subjectKey = user?.id ?? req.headers.get('x-forwarded-for') ?? 'anon';
  const rate = evaluateEdgeRateLimit(subjectKey);

  const rateHeaders = {
    'X-RateLimit-Limit': String(MAX_REQUESTS_PER_MINUTE),
    'X-RateLimit-Remaining': String(rate.remaining),
    ...(rate.allowed ? {} : { 'Retry-After': String(rate.retryAfterSec) }),
  };

  if (!rate.allowed) {
    return new Response(
      JSON.stringify({
        error: `Limite de disparos excedido (${MAX_REQUESTS_PER_MINUTE}/min). Aguarde ${rate.retryAfterSec}s.`,
      }),
      {
        status: 429,
        headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  const body = await req.json();
  const officeId = String(body.officeId ?? '');
  const instruction = String(body.instruction ?? '').trim();
  const clipCount = Number(body.clipCount ?? 3);

  const { data, error } = await supabase.rpc('create_office_run', {
    p_office_id: officeId,
    p_instruction: instruction,
    p_clip_count: clipCount,
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ run: data }), {
    status: 201,
    headers: { ...corsHeaders, ...rateHeaders, 'Content-Type': 'application/json' },
  });
});
