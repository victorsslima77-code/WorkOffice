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
  const action = String(body.action ?? 'block');

  if (!officeId || !agentId) {
    return NextResponse.json({ error: 'Informe officeId e agentId.' }, { status: 400 });
  }

  // Bloqueio / Desbloqueio direto de gasto de tokens do agente (sem gerar chamadas falsas em llm_calls)
  if (action === 'block' || action === 'unblock') {
    const nextStatus = action === 'block' ? 'paused_budget' : 'idle';
    const { data: updatedAgent, error: updateErr } = await supabase
      .from('agents')
      .update({ status: nextStatus })
      .eq('id', agentId)
      .eq('office_id', officeId)
      .select('id, name, status')
      .maybeSingle();

    if (updateErr || !updatedAgent) {
      return NextResponse.json(
        { error: updateErr?.message ?? 'Agente não encontrado neste escritório.' },
        { status: 400 },
      );
    }

    await supabase.from('agent_events').insert({
      office_id: officeId,
      agent_id: agentId,
      task_id: null,
      type: action === 'block' ? 'budget.exceeded' : 'agent.idle',
      payload: {
        message:
          action === 'block'
            ? `Gasto de tokens bloqueado manualmente pelo usuário: ${updatedAgent.name} foi pausado na copa e não consumirá novos tokens.`
            : `Bloqueio de tokens removido pelo usuário: ${updatedAgent.name} está liberado para novas tarefas.`,
      },
    });

    return NextResponse.json({
      result: {
        agent_id: updatedAgent.id,
        status: updatedAgent.status,
        blocked: action === 'block',
      },
    });
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
