'use client';

import { SignInInputSchema } from '@workoffice/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') || '/app';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMsg(null);

    const parsed = SignInInputSchema.safeParse({ email, password });
    if (!parsed.success) {
      setErrorMsg(parsed.error.issues[0]?.message ?? 'Credenciais invalidas.');
      return;
    }

    setLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: parsed.data.email,
        password: parsed.data.password,
      });

      if (error) {
        setErrorMsg(error.message);
        return;
      }

      router.push(nextPath.startsWith('/') ? nextPath : '/app');
      router.refresh();
    } catch {
      setErrorMsg('Falha inesperada ao autenticar. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md border-2 border-amber-500/80 bg-slate-900 p-8 shadow-[6px_6px_0px_0px_rgba(245,158,11,0.3)]">
      <h1 className="mb-1 text-2xl font-bold text-white">Entrar no WorkOffice</h1>
      <p className="mb-6 text-xs text-slate-400">
        Acesse seu escritorio de agentes de IA com seu e-mail e senha.
      </p>

      {errorMsg && (
        <div
          role="alert"
          className="mb-4 border border-red-500/80 bg-red-950/60 p-3 text-xs text-red-200"
        >
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1 block text-xs uppercase text-slate-300">
            E-mail
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="voce@exemplo.com"
            className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="password" className="text-xs uppercase text-slate-300">
              Senha
            </label>
            <Link href="/reset-password" className="text-xs text-amber-400 hover:underline">
              Esqueceu a senha?
            </Link>
          </div>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="********"
            className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full border-2 border-amber-400 bg-amber-500 py-2.5 text-sm font-bold uppercase tracking-wider text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
        >
          {loading ? 'Autenticando...' : 'Entrar'}
        </button>
      </form>

      <div className="mt-6 border-t border-slate-800 pt-4 text-center text-xs text-slate-400">
        Ainda nao tem conta?{' '}
        <Link href="/signup" className="font-bold text-amber-400 hover:underline">
          Criar conta
        </Link>
        <div className="mt-2 flex justify-center gap-3 text-[11px] text-slate-500">
          <Link href="/terms" className="hover:text-amber-300 hover:underline">
            Termos de Uso
          </Link>
          <span>•</span>
          <Link href="/privacy" className="hover:text-amber-300 hover:underline">
            Política de Privacidade
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Suspense fallback={<div className="text-xs text-slate-400">Carregando login...</div>}>
        <SignInForm />
      </Suspense>
    </main>
  );
}
