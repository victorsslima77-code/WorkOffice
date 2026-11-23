import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/offices/[id]
 * Inativa (bloqueia gasto de tokens mantendo historico) ou Reativa um escritorio.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id: officeId } = await context.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { action?: string };
  const action = String(body.action ?? '').trim();

  if (action !== 'inactivate' && action !== 'activate') {
    return NextResponse.json(
      { error: 'Ação inválida. Use "inactivate" ou "activate".' },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc('set_office_active_state', {
    p_office_id: officeId,
    p_active: action === 'activate',
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ result: data });
}

/**
 * DELETE /api/offices/[id]
 * Exclui permanentemente o escritorio e TUDO relacionado a ele no Supabase
 * (banco, filas pgmq, arquivos Storage e segredos OAuth no Vault).
 */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id: officeId } = await context.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const { data, error } = await supabase.rpc('delete_office_completely', {
    p_office_id: officeId,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ result: data });
}
