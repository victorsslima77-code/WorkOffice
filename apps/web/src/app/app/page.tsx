import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  OfficesListGrid,
  type DashboardOfficeAgentSummary,
  type DashboardOfficeItem,
} from '@/components/offices-list-grid';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export default async function WorkspaceAppPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=%2Fapp');
  }

  const [{ data: profile }, { data: offices }, { data: credentials }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, display_name, avatar_url, plan, created_at')
      .eq('id', user.id)
      .maybeSingle(),
    supabase
      .from('offices')
      .select(
        'id, name, status, created_at, agents(id, name, desk_slot, provider, model, effort, sprite_key, status)',
      )
      .order('created_at', { ascending: false }),
    supabase.from('agent_credentials').select('id'),
  ]);

  const userOffices: DashboardOfficeItem[] = (offices ?? []).map((o) => ({
    id: String(o.id),
    name: String(o.name),
    status: String(o.status),
    created_at: String(o.created_at),
    agents: Array.isArray(o.agents) ? (o.agents as DashboardOfficeAgentSummary[]) : [],
  }));
  const credentialsCount = credentials?.length ?? 0;

  return (
    <main className="min-h-screen bg-slate-950 p-6">
      <header className="mx-auto mb-8 flex max-w-5xl flex-wrap items-center justify-between gap-4 border-2 border-slate-700 bg-slate-900 px-6 py-4">
        <div>
          <span className="text-xs uppercase tracking-widest text-amber-400">
            WorkOffice // Painel Principal
          </span>
          <h1 className="text-xl font-bold text-white">
            Olá, {profile?.display_name || user.email}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/app/new-office"
            className="border-2 border-amber-400 bg-amber-500 px-4 py-1.5 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400"
          >
            + Criar Novo Escritório
          </Link>
          <Link
            href="/app/simulator"
            className="border-2 border-amber-500/80 bg-amber-950/50 px-3.5 py-1.5 text-xs font-bold uppercase text-amber-300 hover:border-amber-400"
          >
            Simulador Isométrico (Modo Mock)
          </Link>
          <Link
            href="/app/credentials"
            className="border border-emerald-500/70 bg-emerald-950/50 px-3 py-1.5 text-xs font-bold uppercase text-emerald-300 hover:border-emerald-400"
          >
            🔐 Cofre ({credentialsCount})
          </Link>
          <Link
            href="/profile"
            className="border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
          >
            Meu Perfil
          </Link>
        </div>
      </header>

      {/* LISTA DE ESCRITORIOS CRIADOS PELO USUARIO */}
      <section className="mx-auto mb-8 max-w-5xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">
            Meus Escritórios de IA ({userOffices.length})
          </h2>
          <Link
            href="/app/new-office"
            className="text-xs font-bold uppercase text-amber-400 hover:underline"
          >
            + Fundar outro escritório →
          </Link>
        </div>

        <OfficesListGrid initialOffices={userOffices} />
      </section>
    </main>
  );
}
