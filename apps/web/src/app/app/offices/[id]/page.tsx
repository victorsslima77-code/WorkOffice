'use client';

import {
  estimateTaskCostUsd,
  LLM_MODEL_CATALOG,
  UpdateAgentConfigInputSchema,
  type DeskSlot,
  type EffortLevel,
  type LlmProvider,
  type MaskedCredential,
  type RoleSlug,
  type SpriteKey,
  type VisualOfficeAgent,
} from '@workoffice/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CharacterSpritePicker } from '@/components/character-preview';
import { OfficeInteractiveStage } from '@/components/office-interactive-stage';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

interface AgentRow {
  id: string;
  name: string;
  sprite_key: SpriteKey;
  provider: LlmProvider;
  model: string;
  effort: EffortLevel;
  credential_id: string;
  desk_slot: string;
  monthly_token_budget: number | null;
  status: 'idle' | 'working' | 'paused_budget' | 'error';
  roles: {
    slug: string;
    name: string;
    scope: string;
  } | null;
}

interface OfficeDetail {
  id: string;
  name: string;
  status: string;
  created_at: string;
  office_templates: {
    slug: string;
    name: string;
    description: string;
    max_agents: number;
  } | null;
}

export default function OfficeManagePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const officeId = params.id;

  const [office, setOffice] = useState<OfficeDetail | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
  const [youtubeIntegration, setYoutubeIntegration] = useState<{
    channel_id: string;
    metadata?: {
      channel_title?: string;
      client_id_last4?: string;
      refresh_token_last4?: string;
    };
  } | null>(null);
  const [ytChannelIdInput, setYtChannelIdInput] = useState('');
  const [ytChannelTitleInput, setYtChannelTitleInput] = useState('');
  const [ytClientIdInput, setYtClientIdInput] = useState('');
  const [ytClientSecretInput, setYtClientSecretInput] = useState('');
  const [ytRefreshTokenInput, setYtRefreshTokenInput] = useState('');
  const [showYtVaultForm, setShowYtVaultForm] = useState(false);
  const [connectingYt, setConnectingYt] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingAgentId, setSavingAgentId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function loadOfficeAndAgents() {
    setLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login');
        return;
      }

      const [officeRes, agentsRes, credsRes, ytRes] = await Promise.all([
        supabase
          .from('offices')
          .select('id, name, status, created_at, office_templates(slug, name, description, max_agents)')
          .eq('id', officeId)
          .maybeSingle(),
        supabase
          .from('agents')
          .select(
            'id, name, sprite_key, provider, model, effort, credential_id, desk_slot, monthly_token_budget, status, roles(slug, name, scope)',
          )
          .eq('office_id', officeId)
          .order('desk_slot', { ascending: true }),
        fetch('/api/credentials').then((r) => r.json()),
        fetch(`/api/integrations/youtube?officeId=${encodeURIComponent(officeId)}`).then((r) =>
          r.json(),
        ),
      ]);

      if (officeRes.error || !officeRes.data) {
        setErrorMsg('Escritório não encontrado ou você não tem permissão para acessá-lo.');
        setLoading(false);
        return;
      }

      setOffice(officeRes.data as unknown as OfficeDetail);
      setAgents((agentsRes.data as unknown as AgentRow[]) ?? []);
      setCredentials(credsRes.credentials ?? []);
      setYoutubeIntegration(ytRes.integration ?? null);
    } catch {
      setErrorMsg('Erro ao carregar dados do escritório.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (officeId) {
      void loadOfficeAndAgents();
    }
  }, [officeId]);

  function updateLocalAgent(agentId: string, patch: Partial<AgentRow>) {
    setAgents((prev) =>
      prev.map((agent) => {
        if (agent.id !== agentId) return agent;
        const updated = { ...agent, ...patch };
        if (patch.provider && patch.provider !== agent.provider) {
          const firstModel = LLM_MODEL_CATALOG.find((m) => m.provider === patch.provider);
          const matchingCred = credentials.find((c) => c.provider === patch.provider);
          updated.model = firstModel?.id ?? '';
          updated.credential_id = matchingCred?.id ?? '';
        }
        return updated;
      }),
    );
  }

  async function handleSaveAgent(agent: AgentRow) {
    setStatusMsg(null);
    setErrorMsg(null);

    const parsed = UpdateAgentConfigInputSchema.safeParse({
      agentId: agent.id,
      name: agent.name,
      spriteKey: agent.sprite_key,
      provider: agent.provider,
      model: agent.model,
      effort: agent.effort,
      credentialId: agent.credential_id,
      monthlyTokenBudget: agent.monthly_token_budget,
      status: agent.status,
    });

    if (!parsed.success) {
      setErrorMsg(parsed.error.issues[0]?.message ?? 'Configuração de agente inválida.');
      return;
    }

    setSavingAgentId(agent.id);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase
        .from('agents')
        .update({
          name: parsed.data.name,
          sprite_key: parsed.data.spriteKey,
          provider: parsed.data.provider,
          model: parsed.data.model,
          effort: parsed.data.effort,
          credential_id: parsed.data.credentialId,
          monthly_token_budget: parsed.data.monthlyTokenBudget ?? null,
        })
        .eq('id', agent.id);

      if (error) {
        setErrorMsg(error.message);
        return;
      }

      setStatusMsg(`Configurações do agente "${parsed.data.name}" atualizadas com sucesso!`);
    } catch {
      setErrorMsg('Erro ao salvar alterações do agente.');
    } finally {
      setSavingAgentId(null);
    }
  }

  async function handleSaveYoutubeOAuthToUserVault() {
    setConnectingYt(true);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const channelId = ytChannelIdInput.trim() || `UC_${officeId.slice(0, 8)}`;
      const channelTitle =
        ytChannelTitleInput.trim() || `${office?.name ?? 'Canal'} Shorts (Vault do Usuário)`;
      const clientId = ytClientIdInput.trim() || `wo_test_yt_client_${Date.now()}`;
      const clientSecret = ytClientSecretInput.trim() || `wo_test_yt_secret_${Date.now()}`;
      const refreshToken = ytRefreshTokenInput.trim() || `wo_test_youtube_refresh_${Date.now()}`;

      const res = await fetch('/api/integrations/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          officeId,
          channelId,
          channelTitle,
          clientId,
          clientSecret,
          refreshToken,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? 'Erro ao criptografar credenciais OAuth do YouTube no Vault.');
        return;
      }
      setYoutubeIntegration(data.integration);
      setShowYtVaultForm(false);
      setYtClientSecretInput('');
      setYtRefreshTokenInput('');
      setStatusMsg(
        'Credenciais OAuth 2.0 do YouTube (Client ID, Client Secret e Refresh Token) encapsuladas e criptografadas no seu Cofre (Supabase Vault)!',
      );
    } catch {
      setErrorMsg('Falha ao salvar credenciais do YouTube no Vault.');
    } finally {
      setConnectingYt(false);
    }
  }

  async function handleDisconnectYoutube() {
    setConnectingYt(true);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/integrations/youtube?officeId=${encodeURIComponent(officeId)}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        setYoutubeIntegration(null);
        setStatusMsg('Integração OAuth do YouTube revogada e removida do Vault.');
      }
    } finally {
      setConnectingYt(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6">
        <div className="text-xs text-slate-400">Carregando escritório...</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-5">
      <div className="mx-auto max-w-[1600px]">
        {statusMsg && (
          <div className="mb-3 border border-emerald-500 bg-emerald-950/60 p-3 text-xs text-emerald-200">
            {statusMsg}
          </div>
        )}

        {errorMsg && (
          <div
            role="alert"
            className="mb-3 border border-red-500 bg-red-950/60 p-3 text-xs text-red-200"
          >
            {errorMsg}
          </div>
        )}

        {agents.length > 0 && (
          <div className="mb-6">
            <OfficeInteractiveStage
              officeId={officeId}
              officeName={office?.name ?? 'Estúdio de Shorts'}
              subtitleBadge={
                office?.office_templates?.name ?? 'Estúdio de Shorts para YouTube'
              }
              agents={agents.map(
                (ag): VisualOfficeAgent => ({
                  id: ag.id,
                  name: ag.name,
                  roleSlug: (ag.roles?.slug as RoleSlug) ?? 'scriptwriter',
                  roleName: ag.roles?.name ?? 'Agente',
                  deskSlot: (ag.desk_slot as DeskSlot) ?? 'desk_1',
                  spriteKey: ag.sprite_key,
                  provider: ag.provider,
                  model: ag.model,
                  effort: ag.effort,
                  monthlyTokenBudget: ag.monthly_token_budget,
                  status: ag.status,
                }),
              )}
              headerActions={
                <div className="flex items-center gap-2 border-l border-slate-700 pl-2">
                  <Link
                    href="/app/credentials"
                    className="border border-emerald-500/70 bg-emerald-950/40 px-3 py-1.5 text-xs font-bold uppercase text-emerald-300 hover:border-emerald-400"
                  >
                    Cofre (Vault)
                  </Link>
                  <Link
                    href="/app"
                    className="border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
                  >
                    ← Escritórios
                  </Link>
                </div>
              }
            />
          </div>
        )}

        <section className="mb-6 border-2 border-slate-700 bg-slate-900 p-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
                Cofre do Usuário (BYOK Supabase Vault) // YouTube Data API v3 &amp; Analytics
              </span>
              <h2 className="text-sm font-bold text-white">
                Credenciais OAuth 2.0 do Canal do YouTube (Encapsuladas por Usuário)
              </h2>
              <p className="text-slate-400">
                {youtubeIntegration
                  ? `Canal Conectado: ${youtubeIntegration.metadata?.channel_title ?? youtubeIntegration.channel_id} (${youtubeIntegration.channel_id}) • Client ID: ••••${youtubeIntegration.metadata?.client_id_last4 ?? 'vault'} • Refresh Token: ••••${youtubeIntegration.metadata?.refresh_token_last4 ?? 'vault'}`
                  : 'Cada usuário mantém suas próprias credenciais OAuth (Client ID, Client Secret e Refresh Token) criptografadas no seu Cofre (Supabase Vault), garantindo cota isolada de 10.000 unidades/dia (6 Shorts/dia).'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {youtubeIntegration ? (
                <>
                  <span className="border border-emerald-500/60 bg-emerald-950/60 px-2.5 py-1 text-[10px] font-bold uppercase text-emerald-300">
                    🔒 Criptografado no Cofre do Usuário
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowYtVaultForm((prev) => !prev)}
                    className="border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
                  >
                    Rotacionar Credencial
                  </button>
                  <button
                    type="button"
                    disabled={connectingYt}
                    onClick={handleDisconnectYoutube}
                    className="border border-red-500/70 bg-red-950/40 px-3 py-1.5 text-xs font-bold uppercase text-red-200 hover:border-red-400"
                  >
                    Revogar do Vault
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowYtVaultForm((prev) => !prev)}
                  className="border-2 border-emerald-400 bg-emerald-500 px-4 py-1.5 text-xs font-bold uppercase text-slate-950 hover:bg-emerald-400"
                >
                  {showYtVaultForm
                    ? 'Fechar Cofre YouTube'
                    : '+ Configurar OAuth YouTube no Cofre do Usuário'}
                </button>
              )}
            </div>
          </div>

          {showYtVaultForm && (
            <div className="mt-4 grid gap-3 border-t border-slate-800 pt-4 sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <label className="mb-1 block text-[10px] uppercase text-slate-400">
                  Channel ID do YouTube
                </label>
                <input
                  type="text"
                  value={ytChannelIdInput}
                  onChange={(e) => setYtChannelIdInput(e.target.value)}
                  placeholder="Ex: UC_xYz123..."
                  className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase text-slate-400">
                  Nome do Canal
                </label>
                <input
                  type="text"
                  value={ytChannelTitleInput}
                  onChange={(e) => setYtChannelTitleInput(e.target.value)}
                  placeholder="Ex: Meu Canal de Cortes"
                  className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase text-slate-400">
                  Google OAuth Client ID
                </label>
                <input
                  type="text"
                  value={ytClientIdInput}
                  onChange={(e) => setYtClientIdInput(e.target.value)}
                  placeholder="...apps.googleusercontent.com"
                  className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase text-slate-400">
                  Google OAuth Client Secret
                </label>
                <input
                  type="password"
                  value={ytClientSecretInput}
                  onChange={(e) => setYtClientSecretInput(e.target.value)}
                  placeholder="GOCSPX-..."
                  className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase text-slate-400">
                  OAuth Refresh Token
                </label>
                <input
                  type="password"
                  value={ytRefreshTokenInput}
                  onChange={(e) => setYtRefreshTokenInput(e.target.value)}
                  placeholder="1//0g... (ou vazio p/ Sandbox)"
                  className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                />
              </div>
              <div className="flex items-center justify-end gap-2 sm:col-span-2 lg:col-span-5">
                <span className="mr-auto text-[11px] text-slate-400">
                  Dica: deixe os campos em branco e clique em salvar para gerar uma credencial
                  Sandbox de teste no seu Vault.
                </span>
                <button
                  type="button"
                  disabled={connectingYt}
                  onClick={handleSaveYoutubeOAuthToUserVault}
                  className="border-2 border-amber-400 bg-amber-500 px-4 py-1.5 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400 disabled:opacity-50"
                >
                  {connectingYt
                    ? 'Criptografando no Vault...'
                    : '🔒 Criptografar e Salvar no Cofre do Usuário'}
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="mb-6 border-2 border-slate-700 bg-slate-900 p-5">
          <h2 className="mb-2 text-base font-bold text-white">
            Quadro de Funcionários Contratados ({agents.length} /{' '}
            {office?.office_templates?.max_agents ?? 3} baias ocupadas)
          </h2>
          <p className="mb-4 text-xs text-slate-400">
            Altere o modelo LLM, nível de esforço, credencial do Vault ou orçamento mensal de cada
            agente contratado a qualquer momento.
          </p>

          <div className="grid gap-6 lg:grid-cols-3">
            {agents.map((agent) => {
              const providerModels = LLM_MODEL_CATALOG.filter((m) => m.provider === agent.provider);
              const providerCredentials = credentials.filter((c) => c.provider === agent.provider);
              const estUsd = estimateTaskCostUsd(agent.model, agent.effort);

              return (
                <div
                  key={agent.id}
                  className="border-2 border-amber-500/70 bg-slate-950 p-4 text-xs"
                >
                  <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2">
                    <div>
                      <span className="text-[10px] font-bold uppercase text-amber-400">
                        {agent.desk_slot} // {agent.roles?.name ?? 'Cargo'}
                      </span>
                      <div className="text-sm font-bold text-white">{agent.name}</div>
                    </div>
                    <span className="border border-emerald-500/50 bg-emerald-950/60 px-2 py-0.5 text-[10px] uppercase text-emerald-300">
                      {agent.status}
                    </span>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block uppercase text-slate-400">Nome do Agente</label>
                      <input
                        type="text"
                        value={agent.name}
                        onChange={(e) => updateLocalAgent(agent.id, { name: e.target.value })}
                        className="w-full border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-white"
                      />
                    </div>

                    <CharacterSpritePicker
                      value={agent.sprite_key}
                      onChange={(nextKey) =>
                        updateLocalAgent(agent.id, {
                          sprite_key: nextKey,
                        })
                      }
                    />

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block uppercase text-slate-400">Provedor</label>
                        <select
                          value={agent.provider}
                          onChange={(e) =>
                            updateLocalAgent(agent.id, {
                              provider: e.target.value as LlmProvider,
                            })
                          }
                          className="w-full border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-white"
                        >
                          <option value="anthropic">Anthropic</option>
                          <option value="google">Google</option>
                          <option value="openai">OpenAI</option>
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block uppercase text-slate-400">Esforço</label>
                        <select
                          value={agent.effort}
                          onChange={(e) =>
                            updateLocalAgent(agent.id, {
                              effort: e.target.value as EffortLevel,
                            })
                          }
                          className="w-full border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-white"
                        >
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block uppercase text-slate-400">Modelo LLM</label>
                      <select
                        value={agent.model}
                        onChange={(e) => updateLocalAgent(agent.id, { model: e.target.value })}
                        className="w-full border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-white"
                      >
                        {providerModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block uppercase text-slate-400">
                        Credencial no Vault
                      </label>
                      <select
                        value={agent.credential_id}
                        onChange={(e) =>
                          updateLocalAgent(agent.id, { credential_id: e.target.value })
                        }
                        className="w-full border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-white"
                      >
                        <option value="">-- Selecione --</option>
                        {providerCredentials.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label} (••••{c.last4})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block uppercase text-slate-400">
                        Orçamento Mensal (Tokens)
                      </label>
                      <input
                        type="number"
                        value={agent.monthly_token_budget ?? ''}
                        onChange={(e) =>
                          updateLocalAgent(agent.id, {
                            monthly_token_budget: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        className="w-full border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-white"
                      />
                    </div>

                    <div className="border border-slate-800 bg-slate-900 p-2 text-[11px] text-slate-400">
                      Custo est./tarefa:{' '}
                      <strong className="text-emerald-400">${estUsd.toFixed(4)} USD</strong>
                    </div>

                    <button
                      type="button"
                      disabled={savingAgentId === agent.id}
                      onClick={() => handleSaveAgent(agent)}
                      className="w-full border-2 border-amber-400 bg-amber-500 py-2 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400 disabled:opacity-50"
                    >
                      {savingAgentId === agent.id ? 'Salvando...' : 'Salvar Configuração'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
