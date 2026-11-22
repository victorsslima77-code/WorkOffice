'use client';

import { ResetPasswordRequestSchema, UpdatePasswordInputSchema } from '@workoffice/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = searchParams.get('mode') === 'update' ? 'update' : 'request';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleRequestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusMsg(null);
    setErrorMsg(null);

    const parsed = ResetPasswordRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setErrorMsg(parsed.error.issues[0]?.message ?? 'E-mail invalido.');
      return;
    }

    setLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent('/reset-password?mode=update')}`;
      const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
        redirectTo,
      });

      if (error) {
        setErrorMsg(error.message);
        return;
      }

      setStatusMsg(
        'Enviamos um link de recuperacao para o seu e-mail. Acesse o link para definir uma nova senha.',
      );
    } catch {
      setErrorMsg('Erro inesperado ao solicitar recuperacao de senha.');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusMsg(null);
    setErrorMsg(null);

    const parsed = UpdatePasswordInputSchema.safeParse({
      password,
      confirmPassword,
    });
    if (!parsed.success) {
      setErrorMsg(parsed.error.issues[0]?.message ?? 'Dados de senha invalidos.');
      return;
    }

    setLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.updateUser({
        password: parsed.data.password,
      });

      if (error) {
        setErrorMsg(error.message);
        return;
      }

      setStatusMsg('Senha atualizada com sucesso! Redirecionando para o escritorio...');
      router.push('/app');
    } catch {
      setErrorMsg('Falha ao atualizar a senha.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md border-2 border-amber-500/80 bg-slate-900 p-8 shadow-[6px_6px_0px_0px_rgba(245,158,11,0.3)]">
      <h1 className="mb-1 text-2xl font-bold text-white">
        {mode === 'update' ? 'Definir Nova Senha' : 'Recuperar Senha'}
      </h1>
      <p className="mb-6 text-xs text-slate-400">
        {mode === 'update'
          ? 'Informe e confirme sua nova senha de acesso.'
          : 'Informe seu e-mail para receber o link de redefinicao de senha.'}
      </p>

      {statusMsg && (
        <div className="mb-4 border border-emerald-500 bg-emerald-950/60 p-3 text-xs text-emerald-200">
          {statusMsg}
        </div>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="mb-4 border border-red-500 bg-red-950/60 p-3 text-xs text-red-200"
        >
          {errorMsg}
        </div>
      )}

      {mode === 'update' ? (
        <form onSubmit={handleUpdatePassword} className="space-y-4">
          <div>
            <label htmlFor="newPassword" className="mb-1 block text-xs uppercase text-slate-300">
              Nova Senha
            </label>
            <input
              id="newPassword"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="confirmPassword"
              className="mb-1 block text-xs uppercase text-slate-300"
            >
              Confirmar Nova Senha
            </label>
            <input
              id="confirmPassword"
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full border-2 border-amber-400 bg-amber-500 py-2.5 text-sm font-bold uppercase tracking-wider text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
          >
            {loading ? 'Salvando...' : 'Atualizar Senha'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleRequestReset} className="space-y-4">
          <div>
            <label htmlFor="resetEmail" className="mb-1 block text-xs uppercase text-slate-300">
              E-mail da Conta
            </label>
            <input
              id="resetEmail"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@exemplo.com"
              className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full border-2 border-amber-400 bg-amber-500 py-2.5 text-sm font-bold uppercase tracking-wider text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
          >
            {loading ? 'Enviando...' : 'Enviar Link de Recuperacao'}
          </button>
        </form>
      )}

      <div className="mt-6 border-t border-slate-800 pt-4 text-center text-xs">
        <Link href="/login" className="font-bold text-amber-400 hover:underline">
          Voltar para o Login
        </Link>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Suspense fallback={<div className="text-xs text-slate-400">Carregando...</div>}>
        <ResetPasswordContent />
      </Suspense>
    </main>
  );
}
