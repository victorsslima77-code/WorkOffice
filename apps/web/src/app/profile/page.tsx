'use client';

import { ProfileUpdateInputSchema } from '@workoffice/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export default function ProfilePage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string>('');
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [plan, setPlan] = useState('free');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadProfile() {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login?next=%2Fprofile');
        return;
      }

      setUserId(user.id);
      setEmail(user.email ?? '');

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url, plan')
        .eq('id', user.id)
        .maybeSingle();

      if (error) {
        setErrorMsg(error.message);
      } else if (profile) {
        setDisplayName(profile.display_name ?? '');
        setAvatarUrl(profile.avatar_url ?? '');
        setPlan(profile.plan ?? 'free');
      }

      setLoading(false);
    }

    void loadProfile();
  }, [router]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusMsg(null);
    setErrorMsg(null);

    if (!userId) {
      setErrorMsg('Sessao expirada. Faca login novamente.');
      return;
    }

    const parsed = ProfileUpdateInputSchema.safeParse({
      display_name: displayName,
      avatar_url: avatarUrl || null,
    });

    if (!parsed.success) {
      setErrorMsg(parsed.error.issues[0]?.message ?? 'Dados de perfil invalidos.');
      return;
    }

    setSaving(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase
        .from('profiles')
        .update({
          display_name: parsed.data.display_name,
          avatar_url: parsed.data.avatar_url || null,
        })
        .eq('id', userId);

      if (error) {
        setErrorMsg(error.message);
        return;
      }

      setStatusMsg('Perfil atualizado com sucesso!');
    } catch {
      setErrorMsg('Falha ao atualizar perfil.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="text-xs text-slate-400">Carregando perfil...</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 p-6">
      <div className="mx-auto max-w-lg border-2 border-amber-500/80 bg-slate-900 p-8 shadow-[6px_6px_0px_0px_rgba(245,158,11,0.3)]">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <span className="text-xs uppercase tracking-widest text-amber-400">
              Perfil do Usuario
            </span>
            <h1 className="text-2xl font-bold text-white">Minha Conta</h1>
          </div>
          <Link href="/app" className="text-xs font-bold text-amber-400 hover:underline">
            Voltar ao Painel
          </Link>
        </div>

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

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs uppercase text-slate-400">E-mail</label>
            <input
              type="email"
              disabled
              value={email}
              className="w-full border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-400"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs uppercase text-slate-400">Plano Atual</label>
            <input
              type="text"
              disabled
              value={plan.toUpperCase()}
              className="w-full border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-emerald-400"
            />
          </div>

          <div>
            <label htmlFor="displayName" className="mb-1 block text-xs uppercase text-slate-300">
              Nome de Exibicao
            </label>
            <input
              id="displayName"
              type="text"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="avatarUrl" className="mb-1 block text-xs uppercase text-slate-300">
              URL do Avatar (opcional)
            </label>
            <input
              id="avatarUrl"
              type="url"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="https://exemplo.com/avatar.png"
              className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className="w-full border-2 border-amber-400 bg-amber-500 py-2.5 text-sm font-bold uppercase tracking-wider text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
          >
            {saving ? 'Salvando...' : 'Salvar Alteracoes'}
          </button>
        </form>

        <div className="mt-6 flex items-center justify-between border-t border-slate-800 pt-4">
          <Link href="/reset-password?mode=update" className="text-xs text-slate-400 hover:underline">
            Alterar senha
          </Link>
          <button
            type="button"
            onClick={handleSignOut}
            className="border border-red-500/70 bg-red-950/40 px-3 py-1.5 text-xs font-bold uppercase text-red-300 hover:bg-red-900/50"
          >
            Sair (Logout)
          </button>
        </div>
      </div>
    </main>
  );
}
