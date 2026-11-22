import {
  buildMockShortsScenarioSteps,
  computeOfficeObservabilitySummary,
  CreateOfficeWithAgentsInputSchema,
  evaluateAgentBudgetStatus,
  evaluateRouteAccess,
  ExternalUrlValidationError,
  parseRequestedVideoCount,
  SignUpInputSchema,
  SlidingWindowRateLimiter,
  StoreCredentialInputSchema,
  validateSafeExternalUrl,
  type VisualOfficeAgent,
} from '@workoffice/shared';
import { describe, expect, it } from 'vitest';
import { reconstructInitialStatesFromEvents } from '../lib/stores/office-realtime-store';

describe('Etapa 9 — Suite E2E Completa do Fluxo do Usuario (Cadastro -> Escritorio -> Contratacao -> Run -> Observabilidade & Seguranca)', () => {
  it('executa a jornada ponta a ponta: cadastro, criacao de escritorio, contratacao com BYOK, disparo de run simultanea com handoff nas estantes e auditoria de orcamento/seguranca', () => {
    // 1. Cadastro e Guardas de Rota
    const signUp = SignUpInputSchema.safeParse({
      displayName: 'Estudio Gamer BR',
      email: 'diretor@workoffice.ai',
      password: 'PasswordForte123!',
    });
    expect(signUp.success).toBe(true);
    expect(evaluateRouteAccess('/app/new-office', false).redirectTo).toBe(
      '/login?next=%2Fapp%2Fnew-office',
    );
    expect(evaluateRouteAccess('/terms', false).allowed).toBe(true);
    expect(evaluateRouteAccess('/privacy', false).allowed).toBe(true);

    // 2. Cofre de Chaves BYOK
    const cred = StoreCredentialInputSchema.safeParse({
      provider: 'anthropic',
      label: 'Claude Pro Key',
      apiKey: 'wo_test_anthropic_99887766',
    });
    expect(cred.success).toBe(true);

    // 3. Wizard de Criacao de Escritorio e Contratacao dos 3 Funcionarios
    const officeInput = CreateOfficeWithAgentsInputSchema.safeParse({
      officeName: 'Estudio Shorts Gamer',
      templateSlug: 'youtube-shorts-studio',
      agents: [
        {
          roleSlug: 'scriptwriter',
          name: 'Lucas (Roteirista)',
          spriteKey: 'character_1',
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          effort: 'high',
          credentialId: '11111111-1111-4111-8111-111111111101',
          deskSlot: 'desk_1',
          monthlyTokenBudget: 500_000,
        },
        {
          roleSlug: 'video_editor',
          name: 'Marina (Editora)',
          spriteKey: 'character_2',
          provider: 'google',
          model: 'gemini-2.5-flash',
          effort: 'medium',
          credentialId: '11111111-1111-4111-8111-111111111102',
          deskSlot: 'desk_2',
          monthlyTokenBudget: 500_000,
        },
        {
          roleSlug: 'publisher_analyst',
          name: 'Rafael (Publicador)',
          spriteKey: 'character_3',
          provider: 'openai',
          model: 'gpt-4.1-mini',
          effort: 'low',
          credentialId: '11111111-1111-4111-8111-111111111103',
          deskSlot: 'desk_3',
          monthlyTokenBudget: 300_000,
        },
      ],
    });
    expect(officeInput.success).toBe(true);
    if (!officeInput.success) return;

    // 4. Disparo de Run ("Crie 3 vídeos do vídeo game novo") e Handoff Simultaneo nas Estantes
    const instruction = 'Crie 3 vídeos do vídeo game novo';
    const requestedVideos = parseRequestedVideoCount(instruction);
    expect(requestedVideos).toBe(3);

    const visualAgents: VisualOfficeAgent[] = [
      {
        id: 'agent-scriptwriter',
        name: 'Lucas (Roteirista)',
        roleSlug: 'scriptwriter',
        roleName: 'Roteirista',
        deskSlot: 'desk_1',
        spriteKey: 'character_1',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        monthlyTokenBudget: 500_000,
        status: 'idle',
      },
      {
        id: 'agent-editor',
        name: 'Marina (Editora)',
        roleSlug: 'video_editor',
        roleName: 'Editor de Vídeo',
        deskSlot: 'desk_2',
        spriteKey: 'character_2',
        provider: 'google',
        model: 'gemini-3-flash',
        effort: 'medium',
        monthlyTokenBudget: 500_000,
        status: 'idle',
      },
      {
        id: 'agent-publisher',
        name: 'Rafael (Publicador)',
        roleSlug: 'publisher_analyst',
        roleName: 'Publicador',
        deskSlot: 'desk_3',
        spriteKey: 'character_3',
        provider: 'openai',
        model: 'gpt-5-mini',
        effort: 'low',
        monthlyTokenBudget: 300_000,
        status: 'idle',
      },
    ];

    const scenarioSteps = buildMockShortsScenarioSteps(visualAgents, instruction);
    expect(scenarioSteps.length).toBeGreaterThan(5);

    // Verifica que todas as entregas (handoff.sent) vao para a estante do destinatario (desk_2 ou desk_3)
    const allActions = scenarioSteps.flatMap((step) => [
      step,
      ...(step.concurrentActions ?? []),
    ]);
    const handoffActions = allActions.filter((a) => a.type === 'handoff.sent');
    expect(handoffActions.length).toBe(6); // 3 do Roteirista -> Editora (desk_2) + 3 da Editora -> Publicador (desk_3)
    expect(
      handoffActions.every(
        (a) => a.targetDeskSlot === 'desk_2' || a.targetDeskSlot === 'desk_3',
      ),
    ).toBe(true);

    // 5. Reconstrucao visual via Realtime Store + Pausa Automatica de Orcamento (100%)
    const reconstructed = reconstructInitialStatesFromEvents(visualAgents, [
      {
        id: 1,
        office_id: 'office-e2e-1',
        agent_id: 'agent-scriptwriter',
        task_id: 'task-1',
        type: 'budget.exceeded',
        payload: { message: 'Orçamento mensal atingido (100%). Pausado na copa (💤).' },
        created_at: new Date().toISOString(),
      },
    ]);
    expect(reconstructed['agent-scriptwriter']?.eventType).toBe('budget.exceeded');

    // 6. Observabilidade e Gatilhos 80% / 100%
    const summary = computeOfficeObservabilitySummary({
      calls: [
        {
          id: 'call-1',
          task_id: 'task-1',
          agent_id: 'agent-scriptwriter',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          effort: 'high',
          input_tokens: 3200,
          output_tokens: 1800,
          reasoning_tokens: 4096,
          cost_usd: 0.0124,
          latency_ms: 910,
          error: null,
          created_at: new Date().toISOString(),
        },
      ],
      runsCount: 1,
      publishedShortsCount: 1,
    });
    expect(summary.totalTokens).toBe(9096);
    expect(summary.totalCostUsd).toBe(0.0124);
    expect(evaluateAgentBudgetStatus(9096, 9000).status).toBe('exceeded_100');
    expect(evaluateAgentBudgetStatus(9096, 9000).shouldPause100).toBe(true);
    expect(evaluateAgentBudgetStatus(8100, 10000).status).toBe('warning_80');

    // 7. Rate Limiting e Protecao Anti-SSRF
    const limiter = new SlidingWindowRateLimiter();
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('create-run', 'user-e2e', 1000 + i).allowed).toBe(true);
    }
    expect(limiter.check('create-run', 'user-e2e', 2000).allowed).toBe(false);
    expect(() =>
      validateSafeExternalUrl('http://169.254.169.254/latest/meta-data/'),
    ).toThrow(ExternalUrlValidationError);
  });
});
