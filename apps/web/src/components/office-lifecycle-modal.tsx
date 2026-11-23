'use client';

import { useState } from 'react';

export interface OfficeLifecycleTarget {
  id: string;
  name: string;
  status: string;
}

interface OfficeLifecycleModalProps {
  office: OfficeLifecycleTarget | null;
  onClose: () => void;
  onStatusChanged: (officeId: string, nextStatus: 'active' | 'paused') => void;
  onDeleted: (officeId: string) => void;
}

export function OfficeLifecycleModal({
  office,
  onClose,
  onStatusChanged,
  onDeleted,
}: OfficeLifecycleModalProps) {
  const [confirmDeleteMode, setConfirmDeleteMode] = useState(false);
  const [confirmNameInput, setConfirmNameInput] = useState('');
  const [loadingAction, setLoadingAction] = useState<'inactivate' | 'activate' | 'delete' | null>(
    null,
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!office) return null;

  const isInactive = office.status !== 'active';

  async function handleToggleActive(nextActive: boolean) {
    if (!office) return;
    setErrorMsg(null);
    setLoadingAction(nextActive ? 'activate' : 'inactivate');
    try {
      const res = await fetch(`/api/offices/${encodeURIComponent(office.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: nextActive ? 'activate' : 'inactivate' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? 'Falha ao atualizar status do escritório.');
        return;
      }
      onStatusChanged(office.id, nextActive ? 'active' : 'paused');
      onClose();
    } catch {
      setErrorMsg('Erro de rede ao atualizar status do escritório.');
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleConfirmPermanentDelete() {
    if (!office) return;
    if (confirmNameInput.trim().toLowerCase() !== office.name.trim().toLowerCase()) {
      setErrorMsg(`Digite exatamente "${office.name}" para confirmar a exclusão definitiva.`);
      return;
    }

    setErrorMsg(null);
    setLoadingAction('delete');
    try {
      const res = await fetch(`/api/offices/${encodeURIComponent(office.id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? 'Falha ao excluir escritório.');
        return;
      }
      onDeleted(office.id);
      onClose();
    } catch {
      setErrorMsg('Erro de rede ao excluir escritório.');
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto border-2 border-amber-500 bg-slate-900 p-6 shadow-[8px_8px_0px_0px_rgba(245,158,11,0.28)]">
        <div className="mb-4 flex items-start justify-between border-b border-slate-800 pb-3">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
              Gerenciamento do Escritório
            </span>
            <h3 className="text-lg font-bold text-white">{office.name}</h3>
            <p className="text-xs text-slate-400">
              Escolha se deseja apenas inativar este escritório (preservando todo o histórico) ou
              excluir permanentemente do Supabase.
            </p>
          </div>
          <button
            type="button"
            disabled={loadingAction !== null}
            onClick={onClose}
            className="border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
          >
            ✕ Fechar
          </button>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="mb-4 border border-red-500 bg-red-950/60 p-3 text-xs text-red-200"
          >
            {errorMsg}
          </div>
        )}

        <div className="space-y-4 text-xs">
          {/* Opcao 1: Somente Inativar (ou Reativar) */}
          <div className="border-2 border-amber-500/70 bg-slate-950 p-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-bold uppercase text-amber-300">
                {isInactive
                  ? '🔓 Opção 1 — Reativar Escritório'
                  : '🔒 Opção 1 — Somente Inativar Escritório'}
              </span>
              <span className="border border-amber-500/50 bg-amber-950/50 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-200">
                Mantém Histórico
              </span>
            </div>
            <p className="mb-3 leading-relaxed text-slate-300">
              {isInactive
                ? 'Este escritório está inativo e bloqueado contra gastos de tokens. Reative-o para liberar os agentes novamente.'
                : 'Bloqueia imediatamente todos os agentes deste escritório de gastar tokens, cancela filas ativas e mantém 100% do histórico (execuções, custos, logs, vídeos e integrações) preservado para consulta ou reativação futura.'}
            </p>
            <button
              type="button"
              disabled={loadingAction !== null}
              onClick={() => handleToggleActive(isInactive)}
              className={`w-full border-2 px-4 py-2 text-xs font-bold uppercase transition-colors disabled:opacity-50 ${
                isInactive
                  ? 'border-emerald-400 bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                  : 'border-amber-400 bg-amber-500 text-slate-950 hover:bg-amber-400'
              }`}
            >
              {loadingAction === 'inactivate'
                ? 'Inativando e bloqueando tokens...'
                : loadingAction === 'activate'
                  ? 'Reativando escritório...'
                  : isInactive
                    ? '🔓 Reativar Escritório'
                    : '🔒 Inativar Escritório (Bloquear Tokens e Manter Histórico)'}
            </button>
          </div>

          {/* Opcao 2: Excluir Permanentemente */}
          <div className="border-2 border-red-500/70 bg-red-950/20 p-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-bold uppercase text-red-300">
                🗑️ Opção 2 — Excluir Permanentemente
              </span>
              <span className="border border-red-500/60 bg-red-950/80 px-2 py-0.5 text-[10px] font-bold uppercase text-red-200">
                Irreversível
              </span>
            </div>
            <p className="mb-3 leading-relaxed text-slate-300">
              Apaga definitivamente do Supabase tudo o que pertence a este escritório: agentes,
              execuções, tarefas, logs, custos (<code>llm_calls</code>), métricas, integração
              YouTube no Vault, arquivos no Storage e mensagens na fila.{' '}
              <span className="text-slate-400">
                (Suas chaves globais de IA no Cofre continuam salvas para outros escritórios.)
              </span>
            </p>

            {!confirmDeleteMode ? (
              <button
                type="button"
                disabled={loadingAction !== null}
                onClick={() => {
                  setConfirmDeleteMode(true);
                  setErrorMsg(null);
                }}
                className="w-full border border-red-500 bg-red-950/70 px-4 py-2 text-xs font-bold uppercase text-red-200 hover:bg-red-900/70 disabled:opacity-50"
              >
                🗑️ Quero Excluir Permanentemente...
              </button>
            ) : (
              <div className="space-y-2.5 border-t border-red-900/70 pt-3">
                <label className="block text-[11px] text-red-200">
                  Para confirmar, digite o nome exato do escritório:{' '}
                  <strong className="text-white">{office.name}</strong>
                </label>
                <input
                  type="text"
                  value={confirmNameInput}
                  onChange={(e) => setConfirmNameInput(e.target.value)}
                  placeholder={office.name}
                  className="w-full border border-red-500/70 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-red-400 focus:outline-none"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={loadingAction !== null}
                    onClick={() => {
                      setConfirmDeleteMode(false);
                      setConfirmNameInput('');
                      setErrorMsg(null);
                    }}
                    className="border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-bold uppercase text-slate-200"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={loadingAction !== null}
                    onClick={handleConfirmPermanentDelete}
                    className="flex-1 border-2 border-red-400 bg-red-600 px-4 py-2 text-xs font-bold uppercase text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {loadingAction === 'delete'
                      ? 'Excluindo tudo do Supabase...'
                      : '⚠️ Confirmar Exclusão Definitiva'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
