'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const initialEmail = searchParams.get('email') || '';

  const [email, setEmail] = useState(initialEmail);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleResend() {
    setStatusMsg(null);
    setErrorMsg(null);

    if (!email.trim()) {
      setErrorMsg('Informe o e-mail utilizado no cadastro para reenviar o link.');
      return;
    }

    setLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email.trim(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        setErrorMsg(error.message);
        return;
      }

      setStatusMsg('Novo e-mail de confirmacao enviado! Verifique sua caixa de entrada e spam.');
    } catch {
      setErrorMsg('Erro ao reenviar e-mail de confirmacao.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md border-2 border-emerald-500/80 bg-slate-900 p-8 shadow-[6px_6px_0px_0px_rgba(16,185,129,0.25)]">
      <div className="mb-2 text-xs font-bold uppercase tracking-widest text-emerald-400">
        Verificacao Pendente
      </div>
      <h1 className="mb-2 text-2xl font-bold text-white">Confirme seu E-mail</h1>
      <p className="mb-6 text-xs leading-relaxed text-slate-300">
        Enviamos um link de ativacao para o seu e-mail. Clique no link recebido para confirmar sua
        conta e liberar o acesso ao seu escritorio no WorkOffice.
      </p>

      {statusMsg && (
        <div className="mb-4 border border-emerald-500 bg-emerald-950/60 p-3 text-xs text-emerald-200">
          {statusMsg}
        </div>
      )}

      {errorMsg && (
        <div className="mb-4 border border-red-500 bg-red-950/60 p-3 text-xs text-red-200">
          {errorMsg}
        </div>
      )}

      <div className="space-y-3">
        <label htmlFor="verifyEmailInput" className="block text-xs uppercase text-slate-400">
          E-mail para reenvio
        </label>
        <input
          id="verifyEmailInput"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="voce@exemplo.com"
          className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-emerald-400 focus:outline-none"
        />
        <button
          type="button"
          onClick={handleResend}
          disabled={loading}
          className="w-full border-2 border-emerald-400 bg-emerald-500 py-2 text-xs font-bold uppercase tracking-wider text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {loading ? 'Reenviando...' : 'Reenviar E-mail de Confirmacao'}
        </button>
      </div>

      <div className="mt-6 border-t border-slate-800 pt-4 text-center text-xs">
        <Link href="/login" className="font-bold text-amber-400 hover:underline">
          Voltar para o Login
        </Link>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Suspense fallback={<div className="text-xs text-slate-400">Carregando...</div>}>
        <VerifyEmailContent />
      </Suspense>
    </main>
  );
}
