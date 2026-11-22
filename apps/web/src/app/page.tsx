import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl rounded-none border-2 border-amber-500/80 bg-slate-900 p-8 shadow-[6px_6px_0px_0px_rgba(245,158,11,0.35)]">
        <div className="mb-3 inline-block border border-amber-400/50 bg-amber-500/10 px-2.5 py-1 text-xs uppercase tracking-widest text-amber-300">
          WorkOffice // Retro Isometric AI Studio
        </div>
        <h1 className="mb-4 text-3xl font-bold tracking-tight text-white">
          Seu escritorio virtual de agentes de IA em tempo real
        </h1>
        <p className="mb-8 text-sm leading-relaxed text-slate-300">
          Contrate agentes com modelos e niveis de esforco individuais, acompanhe cada acao
          isometrica no escritorio e monitore custos, tokens e artefatos do seu Estudio de Shorts.
        </p>

        <div className="flex flex-wrap gap-4">
          <Link
            href="/signup"
            className="border-2 border-amber-400 bg-amber-500 px-5 py-2.5 text-sm font-bold uppercase tracking-wider text-slate-950 transition hover:bg-amber-400"
          >
            Criar Conta (Sign Up)
          </Link>
          <Link
            href="/login"
            className="border-2 border-slate-600 bg-slate-800 px-5 py-2.5 text-sm font-bold uppercase tracking-wider text-slate-100 transition hover:border-slate-400"
          >
            Entrar (Sign In)
          </Link>
          <Link
            href="/app"
            className="border-2 border-emerald-500/70 bg-emerald-950/50 px-5 py-2.5 text-sm font-bold uppercase tracking-wider text-emerald-300 transition hover:border-emerald-400"
          >
            Acessar Escritorio
          </Link>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4 text-xs text-slate-400">
          <span>BYOK Seguro via Supabase Vault • Isolamento Multi-Tenant RLS</span>
          <div className="flex gap-4">
            <Link href="/terms" className="text-amber-400 hover:underline">
              Termos de Uso
            </Link>
            <Link href="/privacy" className="text-amber-400 hover:underline">
              Política de Privacidade
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
