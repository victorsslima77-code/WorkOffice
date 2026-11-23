import {
  buildRateLimitHeaders,
  globalRateLimiter,
  parseRequestedVideoCount,
} from '@workoffice/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const officeId = searchParams.get('officeId');

  let query = supabase
    .from('runs')
    .select('id, office_id, input, status, started_at, finished_at, total_tokens, total_cost_usd, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  if (officeId) {
    query = query.eq('office_id', officeId);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ runs: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const rateDecision = globalRateLimiter.check('create-run', user.id);
  const rateHeaders = buildRateLimitHeaders(rateDecision);
  if (!rateDecision.allowed) {
    return NextResponse.json(
      {
        error: `Limite de disparos excedido (${rateDecision.limit} runs/min). Aguarde ${rateDecision.retryAfterSec}s antes de iniciar outra execução.`,
      },
      { status: 429, headers: rateHeaders },
    );
  }

  const body = await request.json();
  const officeId = String(body.officeId ?? '').trim();
  const instruction = String(body.instruction ?? '').trim();
  const clipCount =
    typeof body.clipCount === 'number'
      ? body.clipCount
      : parseRequestedVideoCount(instruction);

  if (!officeId || instruction.length < 3) {
    return NextResponse.json(
      { error: 'Informe o escritório e uma instrução válida para o Roteirista.' },
      { status: 400 },
    );
  }

  // Bloqueia novas execucoes se o escritorio estiver inativo (paused/archived)
  const { data: officeRow } = await supabase
    .from('offices')
    .select('id, status')
    .eq('id', officeId)
    .maybeSingle();

  if (!officeRow) {
    return NextResponse.json({ error: 'Escritório não encontrado.' }, { status: 404 });
  }

  if (officeRow.status !== 'active') {
    return NextResponse.json(
      {
        error:
          'Este escritório está inativo e bloqueado contra gastos de tokens. Reative o escritório antes de iniciar novas atividades.',
      },
      { status: 403 },
    );
  }

  const { data, error } = await supabase.rpc('create_office_run', {
    p_office_id: officeId,
    p_instruction: instruction,
    p_clip_count: clipCount,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ run: data }, { status: 201, headers: rateHeaders });
}
