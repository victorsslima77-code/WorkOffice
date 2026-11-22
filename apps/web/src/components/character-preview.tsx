'use client';

import { SPRITE_CATALOG, type SpriteKey } from '@workoffice/shared';
import { useState } from 'react';

interface CharacterSpritePickerProps {
  value: SpriteKey;
  onChange: (nextKey: SpriteKey) => void;
  compact?: boolean;
}

export function CharacterSpritePicker({
  value,
  onChange,
  compact = false,
}: CharacterSpritePickerProps) {
  const [showSpritesheet, setShowSpritesheet] = useState(false);
  const selected = SPRITE_CATALOG.find((item) => item.key === value) ?? SPRITE_CATALOG[0]!;

  return (
    <div className="space-y-2.5 border border-slate-800 bg-slate-950 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase text-amber-300">
          Visual do Personagem (PNG)
        </span>
        <button
          type="button"
          onClick={() => setShowSpritesheet((prev) => !prev)}
          className="border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-400 hover:border-emerald-400"
        >
          {showSpritesheet ? 'Ver Retrato' : 'Ver Spritesheet PNG'}
        </button>
      </div>

      {/* Área principal de visualização do personagem selecionado */}
      {!showSpritesheet ? (
        <div className="flex items-center gap-3 border border-slate-800/90 bg-slate-900/70 p-2.5">
          <div className="flex h-24 w-20 shrink-0 items-center justify-center border border-amber-500/40 bg-slate-950 p-1.5">
            <img
              src={selected.portraitAsset}
              alt={selected.label}
              className="h-full w-full object-contain"
              style={{ imageRendering: 'pixelated' }}
            />
          </div>
          <div className="min-w-0 flex-1 text-xs">
            <div className="truncate font-bold text-white">{selected.label}</div>
            <div className="mt-0.5 text-[11px] text-slate-400">{selected.description}</div>
            <div className="mt-1.5 inline-block border border-emerald-500/40 bg-emerald-950/40 px-1.5 py-0.5 text-[10px] text-emerald-300">
              Grade Sprite: {selected.spriteGrid.cols}x{selected.spriteGrid.rows} frames PNG
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5 border border-emerald-500/50 bg-slate-900/90 p-2">
          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span>Spritesheet convertido em PNG transparente:</span>
            <code className="text-emerald-300">{selected.spritesheetAsset}</code>
          </div>
          <div className="overflow-x-auto border border-slate-800 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:12px_12px] p-2">
            <img
              src={selected.spritesheetAsset}
              alt={`Spritesheet de ${selected.label}`}
              className="mx-auto max-h-44 w-auto object-contain"
              style={{ imageRendering: 'pixelated' }}
            />
          </div>
        </div>
      )}

      {/* Mini galeria clicável com os 4 personagens de characters.png e characters 2.png */}
      {!compact && (
        <div>
          <div className="mb-1.5 text-[10px] uppercase text-slate-400">
            Escolha o Avatar (characters.png &amp; characters 2.png):
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {SPRITE_CATALOG.map((item) => {
              const isSelected = item.key === value;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onChange(item.key)}
                  title={item.label}
                  className={`flex flex-col items-center border p-1.5 transition ${
                    isSelected
                      ? 'border-amber-400 bg-amber-500/20 shadow-[2px_2px_0px_0px_rgba(245,158,11,0.5)]'
                      : 'border-slate-800 bg-slate-900/60 opacity-75 hover:border-slate-600 hover:opacity-100'
                  }`}
                >
                  <img
                    src={item.portraitAsset}
                    alt={item.label}
                    className="h-12 w-10 object-contain"
                    style={{ imageRendering: 'pixelated' }}
                  />
                  <span className="mt-1 w-full truncate text-center text-[9px] font-bold uppercase text-slate-200">
                    {item.key.replace('character_', 'P')}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
