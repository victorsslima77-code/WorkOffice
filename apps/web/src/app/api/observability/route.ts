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
  const officeId = searchParams.get('officeId') ?? '';

  if (!officeId) {
    return NextResponse.json({ error: 'Informe o officeId.' }, { status: 400 });
  }

  const { data, error } = await supabase.rpc('get_office_observability_dashboard', {
    p_office_id: officeId,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ dashboard: data });
}

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
  const agentId = String(body.agentId ?? '').trim();
  const action = String(body.action ?? 'hit_100');

  if (!officeId || !agentId) {
    return NextResponse.json({ error: 'Informe officeId e agentId.' }, { status: 400 });
  }

  const { data, error } = await supabase.rpc('simulate_agent_budget_consumption', {
    p_office_id: officeId,
    p_agent_id: agentId,
    p_action: action,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ result: data });
}
