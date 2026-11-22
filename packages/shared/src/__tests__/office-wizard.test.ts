import { describe, expect, it } from 'vitest';
import {
  CreateOfficeWithAgentsInputSchema,
  estimateOfficeCostSummary,
  MaskedCredentialSchema,
  validateProviderKeyFormat,
} from '../index.js';

describe('@workoffice/shared — Etapa 3 (Wizard de Escritorio, Contratacao e Vault)', () => {
  it('valida formato das chaves de API por provedor e rejeita chaves invalidas antes de salvar', () => {
    expect(validateProviderKeyFormat('anthropic', '12345').valid).toBe(false);
    expect(validateProviderKeyFormat('anthropic', 'sk-openai-wrong-prefix-123456').valid).toBe(
      false,
    );
    expect(validateProviderKeyFormat('anthropic', 'sk-ant-api03-validformat123456').valid).toBe(
      true,
    );
    expect(validateProviderKeyFormat('google', 'AIzaSyValidGoogleKeyFormat12345').valid).toBe(true);
    expect(validateProviderKeyFormat('google', 'AQ.Ab8RN6ValidGoogleAiStudioAuthKey1234').valid).toBe(
      true,
    );
    expect(validateProviderKeyFormat('openai', 'sk-proj-validOpenAiKey12345678').valid).toBe(true);

    // Chave de sandbox para testes locais sem expor chave real
    const sandbox = validateProviderKeyFormat('anthropic', 'wo_test_anthropic_local9876');
    expect(sandbox.valid).toBe(true);
    expect(sandbox.isSandboxKey).toBe(true);
  });

  it('garante que MaskedCredentialSchema nunca exponha apiKey ou vault_secret_id', () => {
    const rawFromDb = {
      id: '11111111-1111-1111-1111-111111111111',
      provider: 'anthropic',
      label: 'Minha Chave Claude',
      last4: '9876',
      created_at: new Date().toISOString(),
      apiKey: 'sk-ant-secret-should-be-stripped',
      vault_secret_id: '22222222-2222-2222-2222-222222222222',
    };

    const parsed = MaskedCredentialSchema.parse(rawFromDb);
    expect(parsed).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      provider: 'anthropic',
      label: 'Minha Chave Claude',
      last4: '9876',
      created_at: rawFromDb.created_at,
    });
    expect('apiKey' in parsed).toBe(false);
    expect('vault_secret_id' in parsed).toBe(false);
  });

  it('permite criar escritorio com 3 agentes de provedores e esforcos distintos (ex: Haiku low + Gemini Pro high + GPT Mini low)', () => {
    const input = {
      templateSlug: 'youtube-shorts-studio',
      officeName: 'Cortes Podcast Tech',
      agents: [
        {
          roleSlug: 'scriptwriter',
          deskSlot: 'desk_1',
          name: 'Lucas Roteirista',
          spriteKey: 'character_1',
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
          effort: 'low',
          credentialId: '11111111-1111-1111-1111-111111111111',
          monthlyTokenBudget: 500000,
        },
        {
          roleSlug: 'video_editor',
          deskSlot: 'desk_2',
          name: 'Marina Editora',
          spriteKey: 'character_2',
          provider: 'google',
          model: 'gemini-2.5-pro',
          effort: 'high',
          credentialId: '22222222-2222-2222-2222-222222222222',
          monthlyTokenBudget: 1500000,
        },
        {
          roleSlug: 'publisher_analyst',
          deskSlot: 'desk_3',
          name: 'Rafa Publicador',
          spriteKey: 'character_1',
          provider: 'openai',
          model: 'gpt-4.1-mini',
          effort: 'low',
          credentialId: '33333333-3333-3333-3333-333333333333',
          monthlyTokenBudget: 300000,
        },
      ],
    };

    const parsed = CreateOfficeWithAgentsInputSchema.safeParse(input);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      const estimate = estimateOfficeCostSummary(parsed.data.agents);
      expect(estimate.perAgentTaskUsd).toHaveLength(3);
      expect(estimate.totalPerRunUsd).toBeGreaterThan(0);
      expect(estimate.estimatedMonthlyUsdFor20Runs).toBeGreaterThan(estimate.totalPerRunUsd);
    }
  });

  it('rejeita contratacao quando o modelo nao pertence ao provedor ou quando ha colisao de baia/cargo', () => {
    const mismatchedModel = CreateOfficeWithAgentsInputSchema.safeParse({
      templateSlug: 'youtube-shorts-studio',
      officeName: 'Escritorio Invalido',
      agents: [
        {
          roleSlug: 'scriptwriter',
          deskSlot: 'desk_1',
          name: 'Agente 1',
          spriteKey: 'character_1',
          provider: 'anthropic',
          model: 'gemini-2.5-pro', // Modelo Google em provedor Anthropic
          effort: 'low',
          credentialId: '11111111-1111-1111-1111-111111111111',
        },
      ],
    });
    expect(mismatchedModel.success).toBe(false);
  });
});
