'use client';

import type { LlmProvider, MaskedCredential } from '@workoffice/shared';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';

export default function CredentialsVaultPage() {
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateKeyInput, setRotateKeyInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function loadCredentials() {
    setLoading(true);
    try {
      const res = await fetch('/api/credentials');
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? 'Falha ao carregar credenciais.');
      } else {
        setCredentials(data.credentials ?? []);
      }
    } catch {
      setErrorMsg('Erro de comunicação ao listar credenciais.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCredentials();
  }, []);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusMsg(null);
    setErrorMsg(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, label, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? 'Falha ao validar/salvar chave no Vault.');
        return;
      }

      setLabel('');
      setApiKey('');
      setStatusMsg(
        `Chave "${data.credential.label}" (${data.credential.provider}) validada e criptografada no Supabase Vault (final ••••${data.credential.last4}).`,
      );
      await loadCredentials();
    } catch {
      setErrorMsg('Falha inesperada ao salvar credencial.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRotate(credentialId: string) {
    setStatusMsg(null);
    setErrorMsg(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/credentials', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentialId,
          newApiKey: rotateKeyInput,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? 'Falha ao rotacionar chave.');
        return;
      }

      setRotatingId(null);
      setRotateKeyInput('');
      setStatusMsg(`Chave rotacionada com sucesso no Vault (novo final ••••${data.credential.last4}).`);
      await loadCredentials();
    } catch {
      setErrorMsg('Erro ao rotacionar credencial.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(credentialId: string, credLabel: string) {
    setStatusMsg(null);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/credentials?id=${encodeURIComponent(credentialId)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? 'Não foi possível revogar a credencial.');
        return;
      }

      setStatusMsg(`Credencial "${credLabel}" revogada e removida do Supabase Vault.`);
      await loadCredentials();
    } catch {
      setErrorMsg('Erro ao revogar credencial.');
    }
  }

  function fillSandboxKey() {
    const randomSuffix = Math.floor(100000 + Math.random() * 900000);
    setApiKey(`wo_test_${provider}_${randomSuffix}`);
    if (!label.trim()) {
      setLabel(`Chave Sandbox ${provider.toUpperCase()}`);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 p-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-2 border-slate-700 bg-slate-900 px-6 py-4">
          <div>
            <span className="text-xs uppercase tracking-widest text-amber-400">
              Supabase Vault // BYOK Security
            </span>
            <h1 className="text-2xl font-bold text-white">Cofre de Chaves de API</h1>
          </div>
          <div className="flex gap-3">
            <Link
              href="/app/new-office"
              className="border-2 border-amber-400 bg-amber-500 px-4 py-2 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400"
            >
              + Criar Escritório
            </Link>
            <Link
              href="/app"
              className="border border-slate-600 bg-slate-800 px-4 py-2 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
            >
              Voltar ao Painel
            </Link>
          </div>
        </header>

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

        <div className="grid gap-6 md:grid-cols-2">
          <section className="border-2 border-amber-500/70 bg-slate-900 p-6">
            <h2 className="mb-1 text-lg font-bold text-white">Cadastrar Nova Chave</h2>
            <p className="mb-4 text-xs text-slate-400">
              A chave é validada junto ao provedor e criptografada via{' '}
              <code className="text-amber-300">vault.create_secret</code>. O valor real nunca mais
              retorna ao navegador.
            </p>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs uppercase text-slate-300">Provedor LLM</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as LlmProvider)}
                  className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
                >
                  <option value="anthropic">Anthropic (Claude Haiku / Sonnet / Opus)</option>
                  <option value="google">Google (Gemini Flash / Pro)</option>
                  <option value="openai">OpenAI (GPT-4.1 / Mini)</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs uppercase text-slate-300">
                  Rótulo de Identificação
                </label>
                <input
                  type="text"
                  required
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Ex: Chave Claude Roteirista"
                  className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs uppercase text-slate-300">Chave de API Secreta</label>
                  <button
                    type="button"
                    onClick={fillSandboxKey}
                    className="text-[11px] font-bold text-emerald-400 hover:underline"
                  >
                    Gerar chave Sandbox de teste
                  </button>
                </div>
                <input
                  type="password"
                  required
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    provider === 'anthropic'
                      ? 'sk-ant-...'
                      : provider === 'google'
                        ? 'AQ.Ab... ou AIza...'
                        : 'sk-...'
                  }
                  className="w-full border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-amber-400 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full border-2 border-amber-400 bg-amber-500 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
              >
                {submitting ? 'Validando e Criptografando...' : 'Validar e Salvar no Vault'}
              </button>
            </form>
          </section>

          <section className="border-2 border-slate-700 bg-slate-900 p-6">
            <h2 className="mb-1 text-lg font-bold text-white">Credenciais Salvas (Mascaradas)</h2>
            <p className="mb-4 text-xs text-slate-400">
              Exibindo apenas os últimos 4 dígitos (<code className="text-emerald-300">last4</code>
              ). Você pode rotacionar ou revogar chaves a qualquer momento.
            </p>

            {loading ? (
              <div className="text-xs text-slate-400">Carregando cofre...</div>
            ) : credentials.length === 0 ? (
              <div className="border border-dashed border-slate-700 bg-slate-950 p-6 text-center text-xs text-slate-400">
                Nenhuma credencial cadastrada ainda. Cadastre ao lado para contratar seus agentes.
              </div>
            ) : (
              <div className="space-y-3">
                {credentials.map((cred) => (
                  <div
                    key={cred.id}
                    className="border border-slate-800 bg-slate-950 p-3.5 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="mr-2 border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-300">
                          {cred.provider}
                        </span>
                        <span className="font-bold text-white">{cred.label}</span>
                      </div>
                      <span className="font-mono text-emerald-400">••••{cred.last4}</span>
                    </div>

                    {rotatingId === cred.id ? (
                      <div className="mt-3 space-y-2 border-t border-slate-800 pt-3">
                        <input
                          type="password"
                          value={rotateKeyInput}
                          onChange={(e) => setRotateKeyInput(e.target.value)}
                          placeholder="Nova chave de API para rotação..."
                          className="w-full border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-white"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={submitting}
                            onClick={() => handleRotate(cred.id)}
                            className="border border-emerald-400 bg-emerald-500 px-3 py-1 text-[11px] font-bold uppercase text-slate-950"
                          >
                            Confirmar Rotação
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRotatingId(null);
                              setRotateKeyInput('');
                            }}
                            className="border border-slate-600 px-3 py-1 text-[11px] uppercase text-slate-300"
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2.5 flex items-center justify-end gap-3 border-t border-slate-900 pt-2">
                        <button
                          type="button"
                          onClick={() => {
                            setRotatingId(cred.id);
                            setRotateKeyInput('');
                          }}
                          className="text-[11px] font-bold text-amber-400 hover:underline"
                        >
                          Rotacionar
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRevoke(cred.id, cred.label)}
                          className="text-[11px] font-bold text-red-400 hover:underline"
                        >
                          Revogar
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
