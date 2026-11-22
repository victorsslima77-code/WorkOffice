import { z } from 'zod';
import {
  EffortLevelSchema,
  estimateTaskCostUsd,
  getModelFromCatalog,
  LlmProviderSchema,
  type EffortLevel,
  type LlmProvider,
} from './models.js';
import { DeskSlotSchema, RoleSlugSchema } from './roles.js';

export const SpriteKeySchema = z.enum([
  'character_1',
  'character_2',
  'character_3',
  'character_4',
]);
export type SpriteKey = z.infer<typeof SpriteKeySchema>;

export interface CharacterSpriteCatalogItem {
  key: SpriteKey;
  label: string;
  description: string;
  portraitAsset: string;
  sourceSheetAsset: string;
  spritesheetAsset: string;
  spriteGrid: { cols: number; rows: number };
}

export const SPRITE_CATALOG: readonly CharacterSpriteCatalogItem[] = [
  {
    key: 'character_1',
    label: 'Personagem 1 — Camisa Azul',
    description: 'Homem camisa azul (characters.png + character 1.png)',
    portraitAsset: '/assets/character-1-portrait.png',
    sourceSheetAsset: '/assets/characters-sheet-1.png',
    spritesheetAsset: '/assets/character-1-sprites.png',
    spriteGrid: { cols: 8, rows: 3 },
  },
  {
    key: 'character_2',
    label: 'Personagem 2 — Camisa Verde',
    description: 'Mulher camisa verde (characters.png + character 2.png)',
    portraitAsset: '/assets/character-2-portrait.png',
    sourceSheetAsset: '/assets/characters-sheet-1.png',
    spritesheetAsset: '/assets/character-2-sprites.png',
    spriteGrid: { cols: 8, rows: 3 },
  },
  {
    key: 'character_3',
    label: 'Personagem 3 — Óculos & Camisa Azul Clara',
    description: 'Homem de óculos (characters 2.png + character 3.png)',
    portraitAsset: '/assets/character-3-portrait.png',
    sourceSheetAsset: '/assets/characters-sheet-2.png',
    spritesheetAsset: '/assets/character-3-sprites.png',
    spriteGrid: { cols: 8, rows: 4 },
  },
  {
    key: 'character_4',
    label: 'Personagem 4 — Camisa Mostarda',
    description: 'Mulher camisa mostarda (characters 2.png)',
    portraitAsset: '/assets/character-4-portrait.png',
    sourceSheetAsset: '/assets/characters-sheet-2.png',
    spritesheetAsset: '/assets/character-2-sprites.png',
    spriteGrid: { cols: 8, rows: 3 },
  },
] as const;

export const StoreCredentialInputSchema = z.object({
  provider: LlmProviderSchema,
  label: z
    .string()
    .trim()
    .min(2, 'O rótulo da credencial deve ter pelo menos 2 caracteres.')
    .max(60, 'O rótulo não pode exceder 60 caracteres.'),
  apiKey: z
    .string()
    .trim()
    .min(12, 'A chave de API informada é muito curta.')
    .max(512, 'A chave de API excede o tamanho máximo.'),
});
export type StoreCredentialInput = z.infer<typeof StoreCredentialInputSchema>;

export const RotateCredentialInputSchema = z.object({
  credentialId: z.string().uuid('ID de credencial inválido.'),
  newApiKey: z
    .string()
    .trim()
    .min(12, 'A nova chave de API informada é muito curta.')
    .max(512, 'A nova chave de API excede o tamanho máximo.'),
});
export type RotateCredentialInput = z.infer<typeof RotateCredentialInputSchema>;

/**
 * Schema de resposta publica de credenciais (NUNCA inclui apiKey nem vault_secret_id).
 */
export const MaskedCredentialSchema = z.object({
  id: z.string().uuid(),
  provider: LlmProviderSchema,
  label: z.string(),
  last4: z.string().max(8),
  created_at: z.string(),
});
export type MaskedCredential = z.infer<typeof MaskedCredentialSchema>;

/**
 * Valida formato estrutural da chave de API por provedor antes de testar no endpoint remoto.
 * Aceita também chaves de sandbox no formato `wo_test_<provider>_<8+ chars>` para desenvolvimento/testes.
 */
export function validateProviderKeyFormat(
  provider: LlmProvider,
  rawKey: string,
): { valid: boolean; reason?: string; isSandboxKey: boolean } {
  const key = rawKey.trim();

  if (key.length < 12 || /\s/.test(key)) {
    return {
      valid: false,
      reason: 'A chave de API deve ter ao menos 12 caracteres e não conter espaços.',
      isSandboxKey: false,
    };
  }

  const sandboxPrefix = `wo_test_${provider}_`;
  if (key.startsWith(sandboxPrefix) && key.length >= sandboxPrefix.length + 6) {
    return { valid: true, isSandboxKey: true };
  }

  if (provider === 'anthropic' && !key.startsWith('sk-ant-')) {
    return {
      valid: false,
      reason:
        'Chaves da Anthropic devem começar com "sk-ant-" (ou use "wo_test_anthropic_..." para modo sandbox).',
      isSandboxKey: false,
    };
  }

  if (provider === 'google' && !key.startsWith('AIza') && !key.startsWith('AQ.')) {
    return {
      valid: false,
      reason:
        'Chaves do Google Gemini AI Studio devem começar com "AQ." ou "AIza" (ou use "wo_test_google_..." para modo sandbox).',
      isSandboxKey: false,
    };
  }

  if (provider === 'openai' && !key.startsWith('sk-')) {
    return {
      valid: false,
      reason:
        'Chaves da OpenAI devem começar com "sk-" (ou use "wo_test_openai_..." para modo sandbox).',
      isSandboxKey: false,
    };
  }

  return { valid: true, isSandboxKey: false };
}

export const HireAgentSlotInputSchema = z
  .object({
    roleSlug: RoleSlugSchema,
    deskSlot: DeskSlotSchema,
    name: z
      .string()
      .trim()
      .min(2, 'O nome do agente deve ter pelo menos 2 caracteres.')
      .max(50, 'O nome do agente não pode exceder 50 caracteres.'),
    spriteKey: SpriteKeySchema,
    provider: LlmProviderSchema,
    model: z.string().min(2),
    effort: EffortLevelSchema,
    credentialId: z.string().uuid('Selecione uma credencial válida no cofre.'),
    monthlyTokenBudget: z
      .number()
      .int()
      .positive('O orçamento mensal de tokens deve ser positivo.')
      .nullable()
      .optional(),
  })
  .refine(
    (slot) => {
      const catalogEntry = getModelFromCatalog(slot.model);
      return Boolean(catalogEntry && catalogEntry.provider === slot.provider);
    },
    {
      message: 'O modelo selecionado não pertence ao provedor escolhido.',
      path: ['model'],
    },
  );
export type HireAgentSlotInput = z.infer<typeof HireAgentSlotInputSchema>;

export const CreateOfficeWithAgentsInputSchema = z
  .object({
    templateSlug: z.string().default('youtube-shorts-studio'),
    officeName: z
      .string()
      .trim()
      .min(3, 'O nome do escritório deve ter pelo menos 3 caracteres.')
      .max(80, 'O nome do escritório não pode exceder 80 caracteres.'),
    agents: z
      .array(HireAgentSlotInputSchema)
      .min(1, 'Contrate pelo menos 1 agente para inaugurar o escritório.')
      .max(3, 'O modelo Estúdio de Shorts suporta no máximo 3 agentes.'),
  })
  .refine(
    (data) => {
      const roles = new Set(data.agents.map((a) => a.roleSlug));
      const desks = new Set(data.agents.map((a) => a.deskSlot));
      return roles.size === data.agents.length && desks.size === data.agents.length;
    },
    {
      message: 'Cada agente contratado deve ocupar um cargo e uma baia (desk_slot) exclusivos.',
      path: ['agents'],
    },
  );
export type CreateOfficeWithAgentsInput = z.infer<typeof CreateOfficeWithAgentsInputSchema>;

export const UpdateAgentConfigInputSchema = z
  .object({
    agentId: z.string().uuid(),
    name: z.string().trim().min(2).max(50),
    spriteKey: SpriteKeySchema,
    provider: LlmProviderSchema,
    model: z.string().min(2),
    effort: EffortLevelSchema,
    credentialId: z.string().uuid(),
    monthlyTokenBudget: z.number().int().positive().nullable().optional(),
    status: z.enum(['idle', 'working', 'paused_budget', 'error']).optional(),
  })
  .refine(
    (data) => {
      const catalogEntry = getModelFromCatalog(data.model);
      return Boolean(catalogEntry && catalogEntry.provider === data.provider);
    },
    {
      message: 'O modelo selecionado não pertence ao provedor escolhido.',
      path: ['model'],
    },
  );
export type UpdateAgentConfigInput = z.infer<typeof UpdateAgentConfigInputSchema>;

export interface OfficeCostEstimateSummary {
  perAgentTaskUsd: { roleSlug: string; model: string; effort: EffortLevel; estimatedUsd: number }[];
  totalPerRunUsd: number;
  estimatedMonthlyUsdFor20Runs: number;
}

export function estimateOfficeCostSummary(
  agents: readonly Pick<HireAgentSlotInput, 'roleSlug' | 'model' | 'effort'>[],
): OfficeCostEstimateSummary {
  const perAgentTaskUsd = agents.map((agent) => ({
    roleSlug: agent.roleSlug,
    model: agent.model,
    effort: agent.effort,
    estimatedUsd: estimateTaskCostUsd(agent.model, agent.effort),
  }));

  const totalPerRunUsd = Number(
    perAgentTaskUsd.reduce((acc, item) => acc + item.estimatedUsd, 0).toFixed(6),
  );

  return {
    perAgentTaskUsd,
    totalPerRunUsd,
    estimatedMonthlyUsdFor20Runs: Number((totalPerRunUsd * 20).toFixed(4)),
  };
}
