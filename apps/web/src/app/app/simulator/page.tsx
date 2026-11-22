'use client';

import type { VisualOfficeAgent } from '@workoffice/shared';
import { OfficeInteractiveStage } from '@/components/office-interactive-stage';

const DEMO_AGENTS: readonly VisualOfficeAgent[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Lucas (Roteirista)',
    roleSlug: 'scriptwriter',
    roleName: 'Roteirista / Pesquisador',
    deskSlot: 'desk_1',
    spriteKey: 'character_1',
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
    effort: 'low',
    monthlyTokenBudget: 500000,
    status: 'idle',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Marina (Editora)',
    roleSlug: 'video_editor',
    roleName: 'Editor de Vídeo',
    deskSlot: 'desk_2',
    spriteKey: 'character_2',
    provider: 'google',
    model: 'gemini-2.5-pro',
    effort: 'high',
    monthlyTokenBudget: 1500000,
    status: 'idle',
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'Rafael (Publicador)',
    roleSlug: 'publisher_analyst',
    roleName: 'Publicador / Analista',
    deskSlot: 'desk_3',
    spriteKey: 'character_3',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    effort: 'low',
    monthlyTokenBudget: 300000,
    status: 'idle',
  },
];

export default function IsometricSimulatorDemoPage() {
  return (
    <main className="min-h-screen bg-slate-950 px-6 py-5">
      <div className="mx-auto max-w-[1600px]">
        <OfficeInteractiveStage
          officeName="Estúdio de Shorts para YouTube"
          subtitleBadge="WorkOffice // Simulador Isométrico & Observabilidade"
          agents={DEMO_AGENTS}
        />
      </div>
    </main>
  );
}
