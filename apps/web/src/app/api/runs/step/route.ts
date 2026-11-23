import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const body = await request.json();
  const officeId = String(body.officeId ?? '').trim();
  const runId = body.runId ? String(body.runId) : null;

  if (!officeId) {
    return NextResponse.json({ error: 'Informe o officeId.' }, { status: 400 });
  }

  // Verifica se o Worker real (Railway / Docker) está online nos últimos 45 segundos.
  // Se estiver online, NÃO executa o stepper SQL simulado (para não roubar as tasks da fila pgmq
  // antes do Worker real fazer o upload na YouTube Data API v3!).
  const cutoffIso = new Date(Date.now() - 45_000).toISOString();
  const { data: activeWorker } = await supabase
    .from('worker_heartbeats')
    .select('worker_id, status, last_seen_at')
    .neq('worker_id', 'in-process-realtime-stepper')
    .gte('last_seen_at', cutoffIso)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeWorker) {
    let runQuery = supabase
      .from('runs')
      .select('id, status')
      .eq('office_id', officeId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (runId) {
      runQuery = supabase.from('runs').select('id, status').eq('id', runId).limit(1);
    }

    const { data: currentRun } = await runQuery.maybeSingle();
    const isStillRunning =
      currentRun?.status === 'queued' || currentRun?.status === 'running';

    return NextResponse.json({
      stepResult: {
        run_id: currentRun?.id ?? runId,
        run_status: currentRun?.status ?? 'idle',
        has_more: isStillRunning,
        delegated_to_worker: activeWorker.worker_id,
      },
    });
  }

  // Fallback somente quando não há Worker externo online: avança via RPC no Postgres
  const { data, error } = await supabase.rpc('advance_office_run_step', {
    p_office_id: officeId,
    p_run_id: runId,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ stepResult: data });
}
