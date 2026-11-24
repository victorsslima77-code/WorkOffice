import { z } from 'zod';

export const LlmProviderSchema = z.enum(['anthropic', 'google', 'openai']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const EffortLevelSchema = z.enum(['low', 'medium', 'high']);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export interface EffortOperationalConfig {
  level: EffortLevel;
  maxOutputTokens: number;
  thinkingBudgetTokens: number;
  openaiReasoningEffort: 'low' | 'medium' | 'high';
  maxToolIterations: number;
  maxResearchSources: number;
  estimatedTokenMultiplier: number;
}

export const EFFORT_CONFIG_MAP: Record<EffortLevel, EffortOperationalConfig> = {
  low: {
    level: 'low',
    maxOutputTokens: 2048,
    thinkingBudgetTokens: 0,
    openaiReasoningEffort: 'low',
    maxToolIterations: 5,
    maxResearchSources: 5,
    estimatedTokenMultiplier: 1.0,
  },
  medium: {
    level: 'medium',
    maxOutputTokens: 4096,
    thinkingBudgetTokens: 4096,
    openaiReasoningEffort: 'medium',
    maxToolIterations: 12,
    maxResearchSources: 10,
    estimatedTokenMultiplier: 2.5,
  },
  high: {
    level: 'high',
    maxOutputTokens: 8192,
    thinkingBudgetTokens: 16384,
    openaiReasoningEffort: 'high',
    maxToolIterations: 25,
    maxResearchSources: 20,
    estimatedTokenMultiplier: 5.5,
  },
};

export interface LlmModelCatalogEntry {
  id: string;
  provider: LlmProvider;
  displayName: string;
  family: string;
  supportsThinking: boolean;
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
  recommendedEfforts: EffortLevel[];
}

export const LLM_MODEL_CATALOG: readonly LlmModelCatalogEntry[] = [
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    family: 'haiku',
    supportsThinking: true,
    inputCostPerMillionUsd: 1.0,
    outputCostPerMillionUsd: 5.0,
    recommendedEfforts: ['low', 'medium'],
  },
  {
    id: 'claude-3-5-haiku-latest',
    provider: 'anthropic',
    displayName: 'Claude 3.5 Haiku (Legado)',
    family: 'haiku',
    supportsThinking: false,
    inputCostPerMillionUsd: 0.8,
    outputCostPerMillionUsd: 4.0,
    recommendedEfforts: ['low', 'medium'],
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4.6',
    family: 'sonnet',
    supportsThinking: true,
    inputCostPerMillionUsd: 3.0,
    outputCostPerMillionUsd: 15.0,
    recommendedEfforts: ['medium', 'high'],
  },
  {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4 (Legado)',
    family: 'sonnet',
    supportsThinking: true,
    inputCostPerMillionUsd: 3.0,
    outputCostPerMillionUsd: 15.0,
    recommendedEfforts: ['medium', 'high'],
  },
  {
    id: 'claude-opus-4-20250514',
    provider: 'anthropic',
    displayName: 'Claude Opus 4',
    family: 'opus',
    supportsThinking: true,
    inputCostPerMillionUsd: 15.0,
    outputCostPerMillionUsd: 75.0,
    recommendedEfforts: ['high'],
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'google',
    displayName: 'Gemini 2.5 Flash',
    family: 'gemini-flash',
    supportsThinking: true,
    inputCostPerMillionUsd: 0.15,
    outputCostPerMillionUsd: 0.6,
    recommendedEfforts: ['low', 'medium'],
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'google',
    displayName: 'Gemini 2.5 Pro',
    family: 'gemini-pro',
    supportsThinking: true,
    inputCostPerMillionUsd: 1.25,
    outputCostPerMillionUsd: 10.0,
    recommendedEfforts: ['medium', 'high'],
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    displayName: 'GPT-4.1 Mini',
    family: 'gpt-mini',
    supportsThinking: false,
    inputCostPerMillionUsd: 0.4,
    outputCostPerMillionUsd: 1.6,
    recommendedEfforts: ['low', 'medium'],
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    displayName: 'GPT-4.1',
    family: 'gpt',
    supportsThinking: true,
    inputCostPerMillionUsd: 2.0,
    outputCostPerMillionUsd: 8.0,
    recommendedEfforts: ['medium', 'high'],
  },
] as const;

export function getModelFromCatalog(modelId: string): LlmModelCatalogEntry | undefined {
  return LLM_MODEL_CATALOG.find((entry) => entry.id === modelId);
}

export function estimateTaskCostUsd(modelId: string, effort: EffortLevel): number {
  const model = getModelFromCatalog(modelId);
  if (!model) {
    return 0;
  }
  const effortConfig = EFFORT_CONFIG_MAP[effort];
  const baseInputTokens = 4000 * effortConfig.estimatedTokenMultiplier;
  const baseOutputTokens =
    effortConfig.maxOutputTokens * 0.6 + effortConfig.thinkingBudgetTokens * 0.5;

  const inputCost = (baseInputTokens / 1_000_000) * model.inputCostPerMillionUsd;
  const outputCost = (baseOutputTokens / 1_000_000) * model.outputCostPerMillionUsd;
  return Number((inputCost + outputCost).toFixed(6));
}
