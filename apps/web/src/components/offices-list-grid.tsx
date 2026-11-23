'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  OfficeLifecycleModal,
  type OfficeLifecycleTarget,
} from './office-lifecycle-modal';

export interface DashboardOfficeAgentSummary {
  id: string;
  name: string;
  desk_slot: string;
  provider: string;
  model: string;
  effort: string;
  sprite_key: string;
  status: string;
}

export interface DashboardOfficeItem {
  id: string;
  name: string;
  status: string;
  created_at: string;
  agents: DashboardOfficeAgentSummary[];
}

interface OfficesListGridProps {
  initialOffices: DashboardOfficeItem[];
}

export function OfficesListGrid({ initialOffices }: OfficesListGridProps) {
  const router = useRouter();
  const [offices, setOffices] = useState<DashboardOfficeItem[]>(initialOffices);
  const [modalTarget, setModalTarget] = useState<OfficeLifecycleTarget | null>(null);

  function handleStatusChanged(officeId: string, nextStatus: 'active' | 'paused') {
    setOffices((prev) =>
      prev.map((o) =>
        o.id === officeId
          ? {
              ...o,
              status: nextStatus,
              agents: o.agents.map((ag) => ({
                ...ag,
                status: nextStatus === 'paused' ? 'paused_budget' : 'idle',
              })),
            }
          : o,
      ),
    );
    router.refresh();
  }

  function handleDeleted(officeId: string) {
    setOffices((prev) => prev.filter((o) => o.id !== officeId));
    router.refresh();
  }

  if (offices.length === 0) {
    return (
      <div className="border-2 border-dashed border-amber-500/70 bg-slate-900 p-8 text-center">
        <h3 className="mb-2 text-lg font-bold text-white">
          Você ainda não possui nenhum escritório ativo
        </h3>
        <p className="mx-auto mb-6 max-w-xl text-xs leading-relaxed text-slate-300">
          Inicie o Wizard para escolher o modelo{' '}
          <strong className="text-amber-300">Estúdio de Shorts para YouTube</strong>, dar um nome ao
          seu escritório, contratar seus 3 agentes e conectar o OAuth do YouTube.
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
            🔐 Cadastrar Chaves no Cofre
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <OfficeLifecycleModal
        office={modalTarget}
        onClose={() => setModalTarget(null)}
        onStatusChanged={handleStatusChanged}
        onDeleted={handleDeleted}
      />

      <div className="grid gap-6 md:grid-cols-2">
        {offices.map((office) => {
          const isInactive = office.status !== 'active';
          return (
            <div
              key={office.id}
              className={`border-2 bg-slate-900 p-6 ${
                isInactive
                  ? 'border-slate-700 opacity-90 shadow-[6px_6px_0px_0px_rgba(148,163,184,0.12)]'
                  : 'border-amber-500/80 shadow-[6px_6px_0px_0px_rgba(245,158,11,0.25)]'
              }`}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
                    Estúdio de Shorts para YouTube
                  </span>
                  <h3 className="text-lg font-bold text-white">{office.name}</h3>
                </div>
                {isInactive ? (
                  <span className="border border-red-500/70 bg-red-950/70 px-2 py-0.5 text-[10px] font-bold uppercase text-red-200">
                    🔒 Inativo
                  </span>
                ) : (
                  <span className="border border-emerald-500/60 bg-emerald-950/60 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
                    ● Ativo
                  </span>
                )}
              </div>

              <div className="mb-4 space-y-2 border border-slate-800 bg-slate-950 p-3 text-xs">
                <div className="font-bold uppercase text-slate-400">
                  Agentes Contratados ({office.agents.length} / 3):
                </div>
                {office.agents.map((ag) => (
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

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setModalTarget({
                      id: office.id,
                      name: office.name,
                      status: office.status,
                    })
                  }
                  className="border border-red-500/60 bg-red-950/40 px-3 py-2 text-xs font-bold uppercase text-red-200 hover:border-red-400"
                >
                  {isInactive ? '⚙️ Reativar / Excluir' : '🗑️ Inativar / Excluir'}
                </button>
                <Link
                  href={`/app/offices/${office.id}`}
                  className="border-2 border-amber-400 bg-amber-500 px-4 py-2 text-xs font-bold uppercase text-slate-950 hover:bg-amber-400"
                >
                  {isInactive ? 'Ver Histórico →' : 'Gerenciar Escritório & Agentes →'}
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
