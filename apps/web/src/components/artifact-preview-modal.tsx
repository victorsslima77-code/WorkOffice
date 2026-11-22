'use client';

export interface PreviewableArtifact {
  id: string;
  title: string;
  kind: string;
  storagePath?: string | null;
  fromOrTo: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface ArtifactPreviewModalProps {
  artifact: PreviewableArtifact | null;
  onClose: () => void;
}

export function ArtifactPreviewModal({ artifact, onClose }: ArtifactPreviewModalProps) {
  if (!artifact) return null;

  const isVideoShort =
    artifact.kind === 'edited_short' || artifact.title.toLowerCase().endsWith('.mp4');
  const isPublishReport = artifact.kind === 'publish_report';
  const meta = (artifact.metadata ?? {}) as Record<string, unknown>;
  const pubOutput = (meta.output as { published_videos?: Record<string, unknown>[] } | undefined)
    ?.published_videos?.[0];
  const publicationStatus = String(
    meta.publication_status ?? pubOutput?.publication_status ?? 'published',
  );
  const shortUrl = String(
    meta.short_url ?? meta.youtube_url ?? pubOutput?.url ?? 'https://youtube.com/shorts/yt_short_01',
  );
  const scheduleDetails = (meta.schedule_details ?? pubOutput?.schedule_details ?? null) as {
    day_offset?: number;
    slot_in_day?: number;
    daily_quota_limit_videos?: number;
    interval_hours?: number;
    scheduled_for_formatted?: string;
    reason?: string;
  } | null;

  const jsonPayload = JSON.stringify(
    artifact.metadata ?? {
      artifact_id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      storage_path: artifact.storagePath ?? null,
      route: artifact.fromOrTo,
      generated_at: artifact.timestamp,
    },
    null,
    2,
  );

  function handleDownloadFile() {
    if (!artifact) return;
    const isMp4 = isVideoShort;
    const content = isMp4
      ? `WorkOffice Short Preview Metadata\nTitle: ${artifact.title}\nStorage Path: ${artifact.storagePath ?? 'N/A'}\n\n${jsonPayload}`
      : jsonPayload;
    const mime = isMp4 ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8';
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = isMp4
      ? `${artifact.title.replace(/\.mp4$/i, '')}_spec.json`
      : artifact.title.endsWith('.json')
        ? artifact.title
        : `${artifact.title}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <div className="w-full max-w-2xl border-2 border-amber-500 bg-slate-900 p-6 shadow-[8px_8px_0px_0px_rgba(245,158,11,0.3)]">
        <div className="mb-4 flex items-start justify-between border-b border-slate-800 pb-3">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
              Inspeção de Artefato // {artifact.kind}
            </span>
            <h3 className="text-lg font-bold text-white">{artifact.title}</h3>
            <p className="text-xs text-slate-400">
              {artifact.fromOrTo} • {artifact.timestamp}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
          >
            ✕ Fechar
          </button>
        </div>

        {isPublishReport && (
          <div
            className={`mb-4 border-2 p-4 ${
              publicationStatus === 'scheduled'
                ? 'border-amber-500/80 bg-amber-950/30'
                : 'border-emerald-500/80 bg-emerald-950/30'
            }`}
          >
            <div className="mb-2 flex items-center justify-between">
              <span
                className={`border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                  publicationStatus === 'scheduled'
                    ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                    : 'border-emerald-400 bg-emerald-500/20 text-emerald-300'
                }`}
              >
                {publicationStatus === 'scheduled'
                  ? '📅 AGENDADO POR COTA DIÁRIA (MÁX. 6 SHORTS/DIA)'
                  : '✅ PUBLICADO NO YOUTUBE SHORTS (DENTRO DA COTA DIÁRIA)'}
              </span>
              <span className="font-mono text-[11px] text-slate-400">
                1.600 / 10.000 un. API v3
              </span>
            </div>

            {publicationStatus === 'scheduled' && scheduleDetails ? (
              <div className="space-y-1.5 text-xs text-slate-200">
                <div>
                  <span className="font-bold text-amber-300">Data/Hora do Agendamento:</span>{' '}
                  <span className="font-mono">{scheduleDetails.scheduled_for_formatted}</span>
                </div>
                <div>
                  <span className="font-bold text-amber-300">Janela &amp; Periodicidade:</span> Dia +
                  {scheduleDetails.day_offset ?? 1} • Slot {scheduleDetails.slot_in_day ?? 1}/
                  {scheduleDetails.daily_quota_limit_videos ?? 6} (intervalo de{' '}
                  {scheduleDetails.interval_hours ?? 4}h entre publicações)
                </div>
                <p className="text-[11px] text-slate-300">{scheduleDetails.reason}</p>
              </div>
            ) : (
              <div className="space-y-1.5 text-xs text-slate-200">
                <div>
                  <span className="font-bold text-emerald-300">URL do Short Publicado:</span>{' '}
                  <a
                    href={shortUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-emerald-400 underline hover:text-emerald-300"
                  >
                    {shortUrl}
                  </a>
                </div>
                <div className="text-[11px] text-slate-300">
                  Publicado respeitando a periodicidade máxima de 6 vídeos/dia (intervalo de 4h) na
                  YouTube Data API v3.
                </div>
              </div>
            )}
          </div>
        )}

        {isVideoShort ? (
          <div className="mb-4 grid gap-4 sm:grid-cols-2">
            {/* Player Preview Vertical 9:16 com Legenda Burn-in Simulada */}
            <div className="mx-auto flex aspect-[9/16] max-h-72 flex-col justify-between border-2 border-emerald-500/80 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 p-4 text-center">
              <div className="flex items-center justify-between text-[10px] text-slate-400">
                <span className="border border-emerald-500/50 bg-emerald-950/60 px-1.5 py-0.5 font-mono text-emerald-300">
                  9:16 • 1080x1920
                </span>
                <span>00:52s</span>
              </div>

              <div className="my-auto space-y-2">
                <div className="text-2xl">🎬</div>
                <div className="text-xs font-bold text-white">{artifact.title}</div>
                <div className="mx-auto inline-block border border-amber-400 bg-black/90 px-2.5 py-1 text-[11px] font-bold uppercase text-amber-300">
                  &ldquo;LEGENDAS DINÂMICAS QUEIMADAS (BURN-IN)&rdquo;
                </div>
              </div>

              <div className="h-1.5 w-full bg-slate-800">
                <div className="h-full w-3/4 bg-emerald-500" />
              </div>
            </div>

            <div className="flex flex-col justify-between text-xs">
              <div>
                <div className="mb-1 font-bold uppercase text-slate-400">
                  Metadados &amp; Storage Path:
                </div>
                <pre className="max-h-52 overflow-auto border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-emerald-300">
                  {jsonPayload}
                </pre>
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-4">
            <div className="mb-1.5 text-xs font-bold uppercase text-slate-400">
              Conteúdo Estruturado do Artefato (JSON):
            </div>
            <pre className="max-h-72 overflow-auto border border-slate-800 bg-slate-950 p-3.5 font-mono text-xs text-emerald-300">
              {jsonPayload}
            </pre>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-slate-800 pt-3">
          <button
            type="button"
            onClick={handleDownloadFile}
            className="border-2 border-emerald-400 bg-emerald-500 px-4 py-2 text-xs font-bold uppercase text-slate-950 hover:bg-emerald-400"
          >
            ⬇ Baixar Artefato ({isVideoShort ? 'Metadados + SRT' : 'JSON'})
          </button>
          <button
            type="button"
            onClick={onClose}
            className="border border-slate-600 bg-slate-800 px-4 py-2 text-xs font-bold uppercase text-slate-200"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
