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

  const { data, error } = await supabase.rpc('advance_office_run_step', {
    p_office_id: officeId,
    p_run_id: runId,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ stepResult: data });
}
