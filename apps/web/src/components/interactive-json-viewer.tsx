'use client';

import { useState } from 'react';

interface InteractiveJsonViewerProps {
  data: unknown;
  initialExpandDepth?: number;
  maxHeightClassName?: string;
}

interface JsonNodeProps {
  keyName?: string;
  value: unknown;
  depth: number;
  initialExpandDepth: number;
  forceSignal: { version: number; expanded: boolean } | null;
  isLast: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function JsonNode({
  keyName,
  value,
  depth,
  initialExpandDepth,
  forceSignal,
  isLast,
}: JsonNodeProps) {
  const isArr = Array.isArray(value);
  const isObj = isPlainObject(value);
  const isCollapsible = isArr || isObj;

  const [localExpanded, setLocalExpanded] = useState<boolean>(depth < initialExpandDepth);
  const [lastSignalVersion, setLastSignalVersion] = useState<number>(0);

  let expanded = localExpanded;
  if (forceSignal && forceSignal.version !== lastSignalVersion) {
    expanded = forceSignal.expanded;
    setLastSignalVersion(forceSignal.version);
    setLocalExpanded(forceSignal.expanded);
  }

  const comma = isLast ? '' : ',';

  if (!isCollapsible) {
    let renderedValue: React.ReactNode;
    if (typeof value === 'string') {
      const isUrl = /^https?:\/\/\S+$/i.test(value.trim());
      renderedValue = isUrl ? (
        <span className="text-emerald-300">
          &quot;
          <a
            href={value.trim()}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-300 underline decoration-cyan-500/60 hover:text-cyan-200"
          >
            {value}
          </a>
          &quot;
        </span>
      ) : (
        <span className="break-words text-emerald-300">&quot;{value}&quot;</span>
      );
    } else if (typeof value === 'number') {
      renderedValue = <span className="text-amber-300">{String(value)}</span>;
    } else if (typeof value === 'boolean') {
      renderedValue = <span className="text-fuchsia-400">{String(value)}</span>;
    } else if (value === null || value === undefined) {
      renderedValue = <span className="italic text-rose-400">null</span>;
    } else {
      renderedValue = <span className="text-slate-300">{String(value)}</span>;
    }

    return (
      <div className="leading-relaxed">
        {keyName !== undefined && (
          <>
            <span className="text-sky-300">&quot;{keyName}&quot;</span>
            <span className="text-slate-500">: </span>
          </>
        )}
        {renderedValue}
        <span className="text-slate-500">{comma}</span>
      </div>
    );
  }

  const entries: [string, unknown][] = isArr
    ? value.map((item, idx) => [String(idx), item])
    : Object.entries(value);
  const openBracket = isArr ? '[' : '{';
  const closeBracket = isArr ? ']' : '}';

  if (entries.length === 0) {
    return (
      <div className="leading-relaxed">
        {keyName !== undefined && (
          <>
            <span className="text-sky-300">&quot;{keyName}&quot;</span>
            <span className="text-slate-500">: </span>
          </>
        )}
        <span className="text-slate-400">
          {openBracket}
          {closeBracket}
        </span>
        <span className="text-slate-500">{comma}</span>
      </div>
    );
  }

  const summaryLabel = isArr
    ? `${entries.length} ${entries.length === 1 ? 'item' : 'itens'}`
    : `${entries.length} ${entries.length === 1 ? 'chave' : 'chaves'}`;

  return (
    <div className="leading-relaxed">
      <button
        type="button"
        onClick={() => setLocalExpanded((prev) => !prev)}
        className="group inline-flex items-center gap-1 rounded px-0.5 text-left hover:bg-slate-800/80"
        title={expanded ? 'Clique para recolher' : 'Clique para expandir'}
      >
        <span className="inline-block w-3 text-center text-[10px] text-amber-400 transition-transform">
          {expanded ? '▾' : '▸'}
        </span>
        {keyName !== undefined && (
          <>
            <span className="text-sky-300 group-hover:text-sky-200">&quot;{keyName}&quot;</span>
            <span className="text-slate-500">: </span>
          </>
        )}
        <span className="font-bold text-slate-400">{openBracket}</span>
        {!expanded && (
          <>
            <span className="mx-1 rounded border border-slate-700 bg-slate-800/90 px-1.5 py-0 text-[10px] text-slate-300">
              {summaryLabel}
            </span>
            <span className="font-bold text-slate-400">{closeBracket}</span>
            <span className="text-slate-500">{comma}</span>
          </>
        )}
      </button>

      {expanded && (
        <>
          <div className="ml-3 border-l border-slate-800 pl-3">
            {entries.map(([childKey, childVal], idx) => (
              <JsonNode
                key={`${childKey}_${idx}`}
                keyName={isArr ? undefined : childKey}
                value={childVal}
                depth={depth + 1}
                initialExpandDepth={initialExpandDepth}
                forceSignal={forceSignal}
                isLast={idx === entries.length - 1}
              />
            ))}
          </div>
          <div>
            <span className="ml-4 font-bold text-slate-400">{closeBracket}</span>
            <span className="text-slate-500">{comma}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function InteractiveJsonViewer({
  data,
  initialExpandDepth = 2,
  maxHeightClassName = 'max-h-72',
}: InteractiveJsonViewerProps) {
  const [forceSignal, setForceSignal] = useState<{ version: number; expanded: boolean } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <div className="mt-2 border border-slate-800 bg-slate-950">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/90 px-2.5 py-1 text-[10px]">
        <span className="font-mono font-bold uppercase tracking-wider text-slate-400">
          JSON Interativo
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              setForceSignal((prev) => ({ version: (prev?.version ?? 0) + 1, expanded: true }))
            }
            className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-sky-300 hover:border-sky-400"
          >
            + Expandir tudo
          </button>
          <button
            type="button"
            onClick={() =>
              setForceSignal((prev) => ({ version: (prev?.version ?? 0) + 1, expanded: false }))
            }
            className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-amber-300 hover:border-amber-400"
          >
            − Recolher tudo
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300 hover:border-emerald-400"
          >
            {copied ? '✓ Copiado!' : '📋 Copiar'}
          </button>
        </div>
      </div>
      <div className={`${maxHeightClassName} overflow-auto p-2.5 font-mono text-[11px]`}>
        <JsonNode
          value={data}
          depth={0}
          initialExpandDepth={initialExpandDepth}
          forceSignal={forceSignal}
          isLast={true}
        />
      </div>
    </div>
  );
}
