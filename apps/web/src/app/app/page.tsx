import { LLM_MODEL_CATALOG, YOUTUBE_SHORTS_ROLES } from '@workoffice/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export default async function WorkspaceAppPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=%2Fapp');
  }

  const [{ data: profile }, { data: template }, { data: offices }, { data: credentials }] =
    await Promise.all([
      supabase
        .from('profiles')
        .select('id, display_name, avatar_url, plan, created_at')
        .eq('id', user.id)
        .maybeSingle(),
      supabase
        .from('office_templates')
        .select('id, slug, name, description, max_agents')
        .eq('slug', 'youtube-shorts-studio')
        .maybeSingle(),
      supabase
        .from('offices')
        .select(
          'id, name, status, created_at, agents(id, name, desk_slot, provider, model, effort, sprite_key, status)',
        )
        .order('created_at', { ascending: false }),
      supabase.from('agent_credentials').select('id, provider, label, last4'),
    ]);

  const userOffices = offices ?? [];
  const userCredentials = credentials ?? [];

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
            Cofre de Chaves ({userCredentials.length})
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

        {userOffices.length === 0 ? (
          <div className="border-2 border-dashed border-amber-500/70 bg-slate-900 p-8 text-center">
            <h3 className="mb-2 text-lg font-bold text-white">
              Você ainda não possui nenhum escritório ativo
            </h3>
            <p className="mx-auto mb-6 max-w-xl text-xs leading-relaxed text-slate-300">
              Inicie o Wizard para escolher o modelo{' '}
              <strong className="text-amber-300">Estúdio de Shorts para YouTube</strong>, dar um
              nome ao seu escritório e contratar seus 3 agentes (Roteirista, Editor e Publicador)
              com chaves de API encapsuladas no Supabase Vault.
            </p>
            <div className="flex flex-wrap justify-center gap-4">
              <Link
                href="/app/new-office"
                className="border-2 border-amber-400 bg-amber-500 px-6 py-3 text-xs font-bold uppercase tracking-wider text-slate-950 hover:bg-amber-400"
              >
                + Criar Meu Primeiro Escritório
              </Link>
              <Link
                href="/app/credentials"
                className="border-2 border-slate-600 bg-slate-800 px-5 py-3 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
              >
                Cadastrar Chaves de API no Vault
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {userOffices.map((office) => {
              const officeAgents = Array.isArray(office.agents) ? office.agents : [];
              return (
                <div
                  key={office.id}
                  className="border-2 border-amber-500/80 bg-slate-900 p-6 shadow-[6px_6px_0px_0px_rgba(245,158,11,0.25)]"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
                        Estúdio de Shorts para YouTube
                      </span>
                      <h3 className="text-lg font-bold text-white">{office.name}</h3>
                    </div>
                    <span className="border border-emerald-500/60 bg-emerald-950/60 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
                      {office.status}
                    </span>
                  </div>

                  <div className="mb-4 space-y-2 border border-slate-800 bg-slate-950 p-3 text-xs">
                    <div className="font-bold uppercase text-slate-400">
                      Agentes Contratados ({officeAgents.length} / 3):
                    </div>
                    {officeAgents.map((ag) => (
                      <div
                        key={ag.id}
                        className="flex items-center justify-between border-t border-slate-900 pt-1.5"
                      >
                        <span className="font-bold text-slate-200">
                          {ag.name} <code className="text-amber-400">({ag.desk_slot})</code>
                        </span>
                        <span className="text-[11px] text-emerald-400">
                          {ag.provider} / {ag.model} ({ag.effort})
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end">
                    <Link
                      href={`/app/offices/${office.id}`}
                      className="border-2 border-amber-400 bg-amber-500 px-4 py-2 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400"
                    >
                      Gerenciar Escritório & Agentes →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mx-auto grid max-w-5xl gap-6 md:grid-cols-2">
        <div className="border-2 border-slate-700 bg-slate-900 p-6">
          <div className="mb-2 text-xs uppercase tracking-wider text-amber-400">
            Template Disponível ({template?.max_agents ?? 3} vagas)
          </div>
          <h2 className="mb-2 text-lg font-bold text-white">
            {template?.name ?? 'Estúdio de Shorts para YouTube'}
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-slate-300">
            {template?.description ??
              'Pipeline completo de pesquisa, corte vertical 9:16 com legenda e publicação monitorada.'}
          </p>
          <div className="space-y-2 border border-slate-800 bg-slate-950 p-3 text-xs">
            <div className="font-bold uppercase text-slate-300">Cargos do Template:</div>
            {YOUTUBE_SHORTS_ROLES.map((role) => (
              <div
                key={role.slug}
                className="flex items-center justify-between border-t border-slate-800/80 pt-1.5 text-slate-400"
              >
                <span className="text-slate-200">
                  {role.name} (<code className="text-amber-300">{role.deskSlot}</code>)
                </span>
                <span className="uppercase text-emerald-400">esforço: {role.defaultEffort}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="border-2 border-slate-700 bg-slate-900 p-6">
          <h2 className="mb-2 text-lg font-bold text-white">Cofre BYOK & Catálogo Multi-Provedor</h2>
          <p className="mb-4 text-xs leading-relaxed text-slate-300">
            Cada agente contratado encapsula sua chave no Supabase Vault e opera com modelo e
            esforço individuais ({LLM_MODEL_CATALOG.length} modelos disponíveis entre Anthropic,
            Google e OpenAI).
          </p>
          <div className="mb-4 border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
            <div>Credenciais no seu Vault: {userCredentials.length}</div>
            <div>E-mail: {user.email}</div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/credentials"
              className="inline-block border-2 border-emerald-400 bg-emerald-500 px-4 py-2 text-xs font-bold uppercase text-slate-950 hover:bg-emerald-400"
            >
              Abrir Cofre de Chaves
            </Link>
            <Link
              href="/app/new-office"
              className="inline-block border-2 border-amber-400 bg-amber-500 px-4 py-2 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400"
            >
              + Novo Escritório
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
