import { validateProviderKeyFormat, type LlmProvider } from '@workoffice/shared';

export async function verifyProviderApiKey(
  provider: LlmProvider,
  rawKey: string,
): Promise<{ valid: boolean; reason?: string }> {
  const formatCheck = validateProviderKeyFormat(provider, rawKey);
  if (!formatCheck.valid) {
    return { valid: false, reason: formatCheck.reason };
  }

  // Chaves de sandbox explícitas (wo_test_<provider>_...) passam sem chamada HTTP externa
  if (formatCheck.isSandboxKey) {
    return { valid: true };
  }

  const key = rawKey.trim();

  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) {
        return {
          valid: false,
          reason: `Anthropic rejeitou a chave (HTTP ${res.status}). Verifique se a chave está ativa.`,
        };
      }
      return { valid: true };
    }

    if (provider === 'google') {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        method: 'GET',
        headers: {
          'x-goog-api-key': key,
        },
      });
      if (!res.ok) {
        return {
          valid: false,
          reason: `Google Gemini rejeitou a chave (HTTP ${res.status}). Verifique se a chave está ativa.`,
        };
      }
      return { valid: true };
    }

    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });
      if (!res.ok) {
        return {
          valid: false,
          reason: `OpenAI rejeitou a chave (HTTP ${res.status}). Verifique se a chave está ativa.`,
        };
      }
      return { valid: true };
    }

    return { valid: false, reason: 'Provedor não suportado.' };
  } catch (err) {
    return {
      valid: false,
      reason: `Não foi possível validar a chave junto ao provedor: ${(err as Error).message}`,
    };
  }
}
