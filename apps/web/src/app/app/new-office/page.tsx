'use client';

import {
  CreateOfficeWithAgentsInputSchema,
  EFFORT_CONFIG_MAP,
  estimateOfficeCostSummary,
  estimateTaskCostUsd,
  LLM_MODEL_CATALOG,
  SPRITE_CATALOG,
  YOUTUBE_SHORTS_ROLES,
  type DeskSlot,
  type EffortLevel,
  type LlmProvider,
  type MaskedCredential,
  type RoleSlug,
  type SpriteKey,
} from '@workoffice/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { CharacterSpritePicker } from '@/components/character-preview';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

interface SlotDraftState {
  enabled: boolean;
  roleSlug: RoleSlug;
  roleName: string;
  deskSlot: DeskSlot;
  name: string;
  spriteKey: SpriteKey;
  provider: LlmProvider;
  model: string;
  effort: EffortLevel;
  credentialId: string;
  monthlyTokenBudget: string;
}

const INITIAL_SLOTS: SlotDraftState[] = [
  {
    enabled: true,
    roleSlug: 'scriptwriter',
    roleName: 'Roteirista / Pesquisador',
    deskSlot: 'desk_1',
    name: 'Lucas (Roteirista)',
    spriteKey: 'character_1',
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
    effort: 'low',
    credentialId: '',
    monthlyTokenBudget: '500000',
  },
  {
    enabled: true,
    roleSlug: 'video_editor',
    roleName: 'Editor de Vídeo',
    deskSlot: 'desk_2',
    name: 'Marina (Editora)',
    spriteKey: 'character_2',
    provider: 'google',
    model: 'gemini-2.5-pro',
    effort: 'high',
    credentialId: '',
    monthlyTokenBudget: '1500000',
  },
  {
    enabled: true,
    roleSlug: 'publisher_analyst',
    roleName: 'Publicador / Analista',
    deskSlot: 'desk_3',
    name: 'Rafael (Publicador)',
    spriteKey: 'character_3',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    effort: 'low',
    credentialId: '',
    monthlyTokenBudget: '300000',
  },
];

export default function NewOfficeWizardPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [officeName, setOfficeName] = useState('');
  const [slots, setSlots] = useState<SlotDraftState[]>(INITIAL_SLOTS);
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);

  // Modal inline para cadastrar chave rapidamente sem sair do wizard
  const [quickCredProvider, setQuickCredProvider] = useState<LlmProvider>('anthropic');
  const [quickCredLabel, setQuickCredLabel] = useState('');
  const [quickCredKey, setQuickCredKey] = useState('');
  const [showQuickCredForm, setShowQuickCredForm] = useState(false);
  const [savingQuickCred, setSavingQuickCred] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  async function loadCredentials() {
    try {
      const res = await fetch('/api/credentials');
      const data = await res.json();
      if (res.ok) {
        const list: MaskedCredential[] = data.credentials ?? [];
        setCredentials(list);
        setSlots((prev) =>
          prev.map((slot) => {
            const matching = list.find((c) => c.provider === slot.provider);
            return {
              ...slot,
              credentialId:
                slot.credentialId && list.some((c) => c.id === slot.credentialId)
                  ? slot.credentialId
                  : (matching?.id ?? ''),
            };
          }),
        );
      }
    } catch {
      // Ignorado no boot inicial
    }
  }

  useEffect(() => {
    void loadCredentials();
  }, []);

  function updateSlot(index: number, patch: Partial<SlotDraftState>) {
    setSlots((prev) =>
      prev.map((slot, idx) => {
        if (idx !== index) return slot;
        const updated = { ...slot, ...patch };

        // Se mudou o provedor, seleciona automaticamente o primeiro modelo desse provedor e uma credencial compativel
        if (patch.provider && patch.provider !== slot.provider) {
          const firstModel = LLM_MODEL_CATALOG.find((m) => m.provider === patch.provider);
          const matchingCred = credentials.find((c) => c.provider === patch.provider);
          updated.model = firstModel?.id ?? '';
          updated.credentialId = matchingCred?.id ?? '';
        }

        return updated;
      }),
    );
  }

  async function handleQuickCreateCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    setSavingQuickCred(true);

    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: quickCredProvider,
          label: quickCredLabel,
          apiKey: quickCredKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? 'Falha ao salvar chave no Vault.');
        return;
      }

      const created: MaskedCredential = data.credential;
      setQuickCredLabel('');
      setQuickCredKey('');
      setShowQuickCredForm(false);
      setStatusMsg(
        `Chave "${created.label}" (${created.provider}) salva no Vault (••••${created.last4}).`,
      );
      await loadCredentials();
    } catch {
      setErrorMsg('Erro ao cadastrar chave no Vault.');
    } finally {
      setSavingQuickCred(false);
    }
  }

  const activeSlots = slots.filter((s) => s.enabled);
  const costSummary = estimateOfficeCostSummary(
    activeSlots.map((s) => ({
      roleSlug: s.roleSlug,
      model: s.model,
      effort: s.effort,
    })),
  );

  async function handleFinalizeHire() {
    setErrorMsg(null);
    setStatusMsg(null);

    const payload = {
      templateSlug: 'youtube-shorts-studio',
      officeName,
      agents: activeSlots.map((s) => ({
        roleSlug: s.roleSlug,
        deskSlot: s.deskSlot,
        name: s.name,
        spriteKey: s.spriteKey,
        provider: s.provider,
        model: s.model,
        effort: s.effort,
        credentialId: s.credentialId,
        monthlyTokenBudget: s.monthlyTokenBudget ? Number(s.monthlyTokenBudget) : null,
      })),
    };

    const parsed = CreateOfficeWithAgentsInputSchema.safeParse(payload);
    if (!parsed.success) {
      setErrorMsg(parsed.error.issues[0]?.message ?? 'Verifique os dados do escritório e agentes.');
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login?next=%2Fapp%2Fnew-office');
        return;
      }

      const { data: template, error: tplErr } = await supabase
        .from('office_templates')
        .select('id, slug')
        .eq('slug', parsed.data.templateSlug)
        .single();

      if (tplErr || !template) {
        setErrorMsg('Template de escritório não encontrado no banco.');
        return;
      }

      const { data: dbRoles, error: rolesErr } = await supabase
        .from('roles')
        .select('id, slug')
        .eq('template_id', template.id);

      if (rolesErr || !dbRoles) {
        setErrorMsg('Cargos do template não encontrados.');
        return;
      }

      const roleIdBySlug = new Map(dbRoles.map((r) => [r.slug, r.id]));

      const { data: createdOffice, error: officeErr } = await supabase
        .from('offices')
        .insert({
          owner_id: user.id,
          template_id: template.id,
          name: parsed.data.officeName,
          status: 'active',
        })
        .select('id')
        .single();

      if (officeErr || !createdOffice) {
        setErrorMsg(officeErr?.message ?? 'Erro ao criar escritório.');
        return;
      }

      const agentsToInsert = parsed.data.agents.map((agent) => {
        const roleId = roleIdBySlug.get(agent.roleSlug);
        if (!roleId) {
          throw new Error(`Cargo ${agent.roleSlug} inválido.`);
        }
        return {
          office_id: createdOffice.id,
          role_id: roleId,
          name: agent.name,
          sprite_key: agent.spriteKey,
          provider: agent.provider,
          model: agent.model,
          effort: agent.effort,
          credential_id: agent.credentialId,
          desk_slot: agent.deskSlot,
          monthly_token_budget: agent.monthlyTokenBudget ?? null,
          status: 'idle',
        };
      });

      const { error: agentsErr } = await supabase.from('agents').insert(agentsToInsert);
      if (agentsErr) {
        setErrorMsg(agentsErr.message);
        return;
      }

      router.push(`/app/offices/${createdOffice.id}`);
      router.refresh();
    } catch (err) {
      setErrorMsg((err as Error).message || 'Falha inesperada ao fundar escritório.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 p-6">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-2 border-slate-700 bg-slate-900 px-6 py-4">
          <div>
            <span className="text-xs uppercase tracking-widest text-amber-400">
              Wizard de Fundação // Passo {step} de 3
            </span>
            <h1 className="text-2xl font-bold text-white">
              Criar Novo Escritório & Contratar Agentes
            </h1>
          </div>
          <div className="flex gap-3">
            <Link
              href="/app/credentials"
              className="border border-emerald-500/70 bg-emerald-950/40 px-3 py-1.5 text-xs font-bold uppercase text-emerald-300 hover:border-emerald-400"
            >
              Cofre de Chaves ({credentials.length})
            </Link>
            <Link
              href="/app"
              className="border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
            >
              Cancelar / Voltar
            </Link>
          </div>
        </header>

        {/* Barra de Etapas */}
        <div className="mb-6 grid grid-cols-3 gap-3 text-xs font-bold uppercase">
          <button
            type="button"
            onClick={() => setStep(1)}
            className={`border-2 p-3 text-left ${
              step === 1
                ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                : 'border-slate-800 bg-slate-900 text-slate-400'
            }`}
          >
            1. Modelo & Nome do Escritório
          </button>
          <button
            type="button"
            onClick={() => {
              if (officeName.trim().length >= 3) setStep(2);
              else setErrorMsg('Informe um nome com pelo menos 3 caracteres para o escritório.');
            }}
            className={`border-2 p-3 text-left ${
              step === 2
                ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                : 'border-slate-800 bg-slate-900 text-slate-400'
            }`}
          >
            2. Contratar Agentes (Baias 1 a 3)
          </button>
          <button
            type="button"
            onClick={() => {
              if (officeName.trim().length >= 3) setStep(3);
              else setErrorMsg('Informe um nome com pelo menos 3 caracteres para o escritório.');
            }}
            className={`border-2 p-3 text-left ${
              step === 3
                ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                : 'border-slate-800 bg-slate-900 text-slate-400'
            }`}
          >
            3. Estimativa de Custo & Confirmação
          </button>
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

        {/* PASSO 1: ESCOLHA DE TEMPLATE E NOME */}
        {step === 1 && (
          <section className="border-2 border-amber-500/70 bg-slate-900 p-6">
            <h2 className="mb-2 text-lg font-bold text-white">
              Passo 1 — Escolha o Modelo e Nomeie seu Escritório
            </h2>
            <p className="mb-6 text-xs text-slate-300">
              Cada modelo de escritório possui salas pré-definidas e um fluxo de trabalho entre
              cargos.
            </p>

            <div className="mb-6 border-2 border-emerald-500/80 bg-slate-950 p-5">
              <div className="mb-2 flex items-center justify-between">
                <span className="border border-emerald-400 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
                  Modelo Selecionado (MVP)
                </span>
                <span className="text-xs text-slate-400">
                  6 ambientes: 3 Baias + Sala de Reunião + Copa + Corredor
                </span>
              </div>
              <h3 className="mb-1 text-base font-bold text-white">
                Estúdio de Shorts para YouTube
              </h3>
              <p className="mb-3 text-xs text-slate-300">
                Pipeline completo com até 3 especialistas: Roteirista/Pesquisador (Baia 1) → Editor
                de Vídeo 9:16 (Baia 2) → Publicador/Analista de Métricas (Baia 3).
              </p>
              <div className="mb-4 flex justify-center border border-slate-800 bg-slate-900/70 p-3">
                <img
                  src="/assets/office.png"
                  alt="Planta isométrica do Estúdio de Shorts"
                  className="max-h-56 w-auto object-contain"
                  style={{ imageRendering: 'pixelated' }}
                />
              </div>
              <div className="grid gap-2 text-[11px] text-slate-400 sm:grid-cols-3">
                {YOUTUBE_SHORTS_ROLES.map((r) => (
                  <div key={r.slug} className="border border-slate-800 bg-slate-900 p-2.5">
                    <div className="font-bold text-amber-300">{r.name}</div>
                    <div>Slot: {r.deskSlot}</div>
                    <div>Esforço padrão: {r.defaultEffort}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mb-6">
              <label
                htmlFor="officeNameInput"
                className="mb-1.5 block text-xs font-bold uppercase text-slate-200"
              >
                Nome do seu Escritório
              </label>
              <input
                id="officeNameInput"
                type="text"
                required
                value={officeName}
                onChange={(e) => setOfficeName(e.target.value)}
                placeholder="Ex: Estúdio Cortes Flow Tech"
                className="w-full border-2 border-slate-700 bg-slate-950 px-4 py-2.5 text-sm text-white focus:border-amber-400 focus:outline-none"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  if (officeName.trim().length < 3) {
                    setErrorMsg('O nome do escritório deve ter pelo menos 3 caracteres.');
                    return;
                  }
                  setErrorMsg(null);
                  setStep(2);
                }}
                className="border-2 border-amber-400 bg-amber-500 px-6 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-950 hover:bg-amber-400"
              >
                Avançar para Contratação de Agentes →
              </button>
            </div>
          </section>
        )}

        {/* PASSO 2: CONTRATACAO INDIVIDUAL POR VAGA/BAIA */}
        {step === 2 && (
          <section className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-2 border-slate-700 bg-slate-900 p-4">
              <div>
                <h2 className="text-lg font-bold text-white">
                  Passo 2 — Contratar Agentes para &ldquo;{officeName}&rdquo;
                </h2>
                <p className="text-xs text-slate-300">
                  Configure provedor, modelo, esforço e chave de API individualmente por empregado
                  (ex: Claude Haiku Low no Roteirista + Gemini Pro High no Editor).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowQuickCredForm((v) => !v)}
                className="border-2 border-emerald-400 bg-emerald-500 px-4 py-2 text-xs font-bold uppercase text-slate-950 hover:bg-emerald-400"
              >
                {showQuickCredForm ? 'Fechar Cofre Rápido' : '+ Adicionar Chave de API no Vault'}
              </button>
            </div>

            {showQuickCredForm && (
              <form
                onSubmit={handleQuickCreateCredential}
                className="border-2 border-emerald-500 bg-slate-900 p-5"
              >
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-bold uppercase text-emerald-300">
                    Cadastro Rápido de Chave no Supabase Vault
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      const suffix = Math.floor(100000 + Math.random() * 900000);
                      setQuickCredKey(`wo_test_${quickCredProvider}_${suffix}`);
                      if (!quickCredLabel.trim()) {
                        setQuickCredLabel(`Chave Sandbox ${quickCredProvider.toUpperCase()}`);
                      }
                    }}
                    className="text-xs font-bold text-amber-400 hover:underline"
                  >
                    Preencher com chave Sandbox de teste
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <select
                    value={quickCredProvider}
                    onChange={(e) => setQuickCredProvider(e.target.value as LlmProvider)}
                    className="border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="google">Google Gemini</option>
                    <option value="openai">OpenAI</option>
                  </select>
                  <input
                    type="text"
                    required
                    value={quickCredLabel}
                    onChange={(e) => setQuickCredLabel(e.target.value)}
                    placeholder="Rótulo (ex: Chave Principal)"
                    className="border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                  <input
                    type="password"
                    required
                    value={quickCredKey}
                    onChange={(e) => setQuickCredKey(e.target.value)}
                    placeholder="Chave secreta ou wo_test_..."
                    className="border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="submit"
                    disabled={savingQuickCred}
                    className="border border-emerald-400 bg-emerald-500 px-4 py-1.5 text-xs font-bold uppercase text-slate-950"
                  >
                    {savingQuickCred ? 'Validando...' : 'Validar e Salvar no Vault'}
                  </button>
                </div>
              </form>
            )}

            <div className="grid gap-6 lg:grid-cols-3">
              {slots.map((slot, index) => {
                const providerModels = LLM_MODEL_CATALOG.filter(
                  (m) => m.provider === slot.provider,
                );
                const providerCredentials = credentials.filter((c) => c.provider === slot.provider);
                const effortInfo = EFFORT_CONFIG_MAP[slot.effort];
                const taskCostUsd = estimateTaskCostUsd(slot.model, slot.effort);

                return (
                  <div
                    key={slot.roleSlug}
                    className={`border-2 bg-slate-900 p-5 ${
                      slot.enabled ? 'border-amber-500/80' : 'border-slate-800 opacity-60'
                    }`}
                  >
                    <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-3">
                      <div>
                        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                          Baia: {slot.deskSlot}
                        </span>
                        <h3 className="text-base font-bold text-white">{slot.roleName}</h3>
                      </div>
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-300">
                        <input
                          type="checkbox"
                          checked={slot.enabled}
                          onChange={(e) => updateSlot(index, { enabled: e.target.checked })}
                        />
                        Contratar
                      </label>
                    </div>

                    {slot.enabled && (
                      <div className="space-y-3 text-xs">
                        <div>
                          <label className="mb-1 block uppercase text-slate-400">
                            Nome do Empregado
                          </label>
                          <input
                            type="text"
                            value={slot.name}
                            onChange={(e) => updateSlot(index, { name: e.target.value })}
                            className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                          />
                        </div>

                        <CharacterSpritePicker
                          value={slot.spriteKey}
                          onChange={(nextKey) => updateSlot(index, { spriteKey: nextKey })}
                        />

                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="mb-1 block uppercase text-slate-400">Provedor</label>
                            <select
                              value={slot.provider}
                              onChange={(e) =>
                                updateSlot(index, { provider: e.target.value as LlmProvider })
                              }
                              className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                            >
                              <option value="anthropic">Anthropic</option>
                              <option value="google">Google</option>
                              <option value="openai">OpenAI</option>
                            </select>
                          </div>

                          <div>
                            <label className="mb-1 block uppercase text-slate-400">Esforço</label>
                            <select
                              value={slot.effort}
                              onChange={(e) =>
                                updateSlot(index, { effort: e.target.value as EffortLevel })
                              }
                              className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                            >
                              <option value="low">Low (Econômico)</option>
                              <option value="medium">Medium (Padrão)</option>
                              <option value="high">High (Deep Thinking)</option>
                            </select>
                          </div>
                        </div>

                        <div>
                          <label className="mb-1 block uppercase text-slate-400">Modelo LLM</label>
                          <select
                            value={slot.model}
                            onChange={(e) => updateSlot(index, { model: e.target.value })}
                            className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                          >
                            {providerModels.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.displayName} (${m.inputCostPerMillionUsd}/M in)
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <div className="mb-1 flex items-center justify-between">
                            <label className="uppercase text-slate-400">
                              Chave no Vault ({slot.provider})
                            </label>
                            {providerCredentials.length === 0 && (
                              <button
                                type="button"
                                onClick={() => {
                                  setQuickCredProvider(slot.provider);
                                  setShowQuickCredForm(true);
                                }}
                                className="text-[11px] font-bold text-amber-400 hover:underline"
                              >
                                + Cadastrar chave
                              </button>
                            )}
                          </div>
                          <select
                            value={slot.credentialId}
                            onChange={(e) => updateSlot(index, { credentialId: e.target.value })}
                            className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                          >
                            <option value="">-- Selecione uma credencial --</option>
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
                            min={10000}
                            step={50000}
                            value={slot.monthlyTokenBudget}
                            onChange={(e) =>
                              updateSlot(index, { monthlyTokenBudget: e.target.value })
                            }
                            placeholder="Ex: 500000"
                            className="w-full border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-white"
                          />
                        </div>

                        <div className="border border-slate-800 bg-slate-950 p-2.5 text-[11px] text-slate-400">
                          <div>
                            Teto output: <strong className="text-slate-200">{effortInfo.maxOutputTokens}</strong>{' '}
                            tok | Thinking:{' '}
                            <strong className="text-slate-200">{effortInfo.thinkingBudgetTokens}</strong> tok
                          </div>
                          <div>
                            Iterações máx: <strong className="text-slate-200">{effortInfo.maxToolIterations}</strong>{' '}
                            | Custo est./tarefa:{' '}
                            <strong className="text-emerald-400">${taskCostUsd.toFixed(4)} USD</strong>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between border-2 border-slate-700 bg-slate-900 p-4">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="border border-slate-600 bg-slate-800 px-5 py-2 text-xs font-bold uppercase text-slate-200"
              >
                ← Voltar
              </button>
              <div className="text-xs text-slate-300">
                Custo estimado por execução completa ({activeSlots.length} agentes):{' '}
                <strong className="text-emerald-400">
                  ${costSummary.totalPerRunUsd.toFixed(4)} USD
                </strong>
              </div>
              <button
                type="button"
                onClick={() => setStep(3)}
                className="border-2 border-amber-400 bg-amber-500 px-6 py-2.5 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400"
              >
                Revisar Contratação →
              </button>
            </div>
          </section>
        )}

        {/* PASSO 3: REVISAO E CONFIRMACAO */}
        {step === 3 && (
          <section className="border-2 border-amber-500/80 bg-slate-900 p-6">
            <h2 className="mb-2 text-lg font-bold text-white">
              Passo 3 — Revisão Final e Estimativa de Custos
            </h2>
            <p className="mb-6 text-xs text-slate-300">
              Confira o quadro de funcionários de IA do escritório{' '}
              <strong className="text-amber-300">{officeName}</strong> antes de inaugurar.
            </p>

            <div className="mb-6 space-y-3">
              {activeSlots.map((slot) => {
                const cred = credentials.find((c) => c.id === slot.credentialId);
                const estUsd = estimateTaskCostUsd(slot.model, slot.effort);
                const spriteInfo =
                  SPRITE_CATALOG.find((s) => s.key === slot.spriteKey) ?? SPRITE_CATALOG[0]!;
                return (
                  <div
                    key={slot.roleSlug}
                    className="flex flex-wrap items-center justify-between gap-4 border border-slate-800 bg-slate-950 p-4 text-xs"
                  >
                    <div className="flex items-center gap-3.5">
                      <div className="flex h-16 w-14 shrink-0 items-center justify-center border border-amber-500/40 bg-slate-900 p-1">
                        <img
                          src={spriteInfo.portraitAsset}
                          alt={spriteInfo.label}
                          className="h-full w-full object-contain"
                          style={{ imageRendering: 'pixelated' }}
                        />
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase text-amber-400">
                          {slot.roleName} // {slot.deskSlot}
                        </div>
                        <div className="text-sm font-bold text-white">{slot.name}</div>
                        <div className="text-slate-400">
                          {spriteInfo.label} | Orçamento:{' '}
                          {slot.monthlyTokenBudget
                            ? `${Number(slot.monthlyTokenBudget).toLocaleString()} tokens/mês`
                            : 'Sem limite'}
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="font-bold uppercase text-slate-200">
                        {slot.provider} / {slot.model}
                      </div>
                      <div className="text-emerald-400">
                        Esforço: {slot.effort.toUpperCase()} (~${estUsd.toFixed(4)} USD / task)
                      </div>
                      <div className="text-slate-400">
                        Credencial:{' '}
                        {cred ? (
                          <span className="text-slate-200">
                            {cred.label} (••••{cred.last4})
                          </span>
                        ) : (
                          <span className="font-bold text-red-400">
                            Nenhuma credencial selecionada!
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mb-6 grid gap-4 border border-emerald-500/50 bg-emerald-950/20 p-4 text-xs sm:grid-cols-3">
              <div>
                <div className="text-slate-400">Agentes Contratados</div>
                <div className="text-lg font-bold text-white">{activeSlots.length} / 3 vagas</div>
              </div>
              <div>
                <div className="text-slate-400">Custo Estimado por Execução (Run)</div>
                <div className="text-lg font-bold text-emerald-400">
                  ${costSummary.totalPerRunUsd.toFixed(4)} USD
                </div>
              </div>
              <div>
                <div className="text-slate-400">Projeção Mensal (~20 Runs)</div>
                <div className="text-lg font-bold text-amber-300">
                  ${costSummary.estimatedMonthlyUsdFor20Runs.toFixed(2)} USD
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="border border-slate-600 bg-slate-800 px-5 py-2.5 text-xs font-bold uppercase text-slate-200"
              >
                ← Ajustar Agentes
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleFinalizeHire}
                className="border-2 border-amber-400 bg-amber-500 px-8 py-3 text-sm font-bold uppercase tracking-wider text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {submitting ? 'Fundando Escritório...' : 'Confirmar e Inaugurar Escritório'}
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
