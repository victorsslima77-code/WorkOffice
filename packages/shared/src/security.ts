export class ExternalUrlValidationError extends Error {
  constructor(url: string, reason: string) {
    super(`URL externa bloqueada (${url}): ${reason}`);
    this.name = 'ExternalUrlValidationError';
  }
}

export const ALLOWED_MEDIA_SOURCE_DOMAINS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
] as const;

export interface ValidateSafeUrlOptions {
  /**
   * Quando true, exige que o host pertença explicitamente a ALLOWED_MEDIA_SOURCE_DOMAINS
   * (usado antes de chamadas ao yt-dlp ou download de segmentos de mídia).
   */
  enforceAllowedMediaHost?: boolean;
}

function isPrivateOrReservedIpv4(host: string): boolean {
  // Bloqueia notação IPv4 decimal pura, octal ou hexadecimal (ex: 2130706433, 0x7f000001, 0177.0.0.1)
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }

  const ipv4Parts = host.split('.');
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p))) {
    // Rejeita octetos com zero à esquerda (octal) ou hexadecimal
    if (ipv4Parts.some((p) => (p.length > 1 && p.startsWith('0')) || p.toLowerCase().startsWith('0x'))) {
      return true;
    }

    const octets = ipv4Parts.map((p) => Number(p));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }

    const [a, b] = octets as [number, number, number, number];
    if (
      a === 0 || // 0.0.0.0/8
      a === 10 || // 10.0.0.0/8 (RFC1918)
      a === 127 || // 127.0.0.0/8 (Loopback)
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (CGNAT / Alibaba Metadata 100.100.100.200)
      (a === 169 && b === 254) || // 169.254.0.0/16 (Link-Local / Cloud Metadata 169.254.169.254)
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 (RFC1918)
      (a === 192 && b === 168) || // 192.168.0.0/16 (RFC1918)
      (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 (Benchmark)
      a >= 224 // Multicast & Reserved (224.0.0.0/4, 240.0.0.0/4)
    ) {
      return true;
    }
  }

  return false;
}

function isPrivateOrReservedIpv6(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes(':')) {
    return false;
  }

  if (
    host === '::1' ||
    host === '::' ||
    host === '0:0:0:0:0:0:0:1' ||
    host === '0:0:0:0:0:0:0:0' ||
    host.startsWith('fe80:') || // Link-local IPv6
    host.startsWith('fc') || // Unique local fc00::/7
    host.startsWith('fd') || // Unique local fd00::/8
    host.startsWith('ff') || // Multicast
    host.startsWith('::ffff:') || // IPv4-mapped IPv6
    host.startsWith('0:0:0:0:0:ffff:')
  ) {
    return true;
  }

  return false;
}

/**
 * Validação rigorosa de URLs externas contra Server-Side Request Forgery (SSRF):
 * - Permite apenas esquemas HTTP/HTTPS
 * - Bloqueia credenciais embutidas na URL (user:pass@host)
 * - Bloqueia portas não-padrão (apenas 80, 443 ou porta padrão vazia)
 * - Bloqueia localhost, IPs privados/loopback/link-local/cloud metadata (169.254.169.254),
 *   IPv6 locais/mapeados e sufixos internos (.local, .internal, .localhost, .lan)
 * - Opcionalmente exige que o domínio pertença à allowlist de mídia (YouTube)
 */
export function validateSafeExternalUrl(
  rawUrl: string,
  options: ValidateSafeUrlOptions = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ExternalUrlValidationError(rawUrl, 'Formato de URL invalido.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ExternalUrlValidationError(rawUrl, 'Apenas protocolos HTTP/HTTPS sao permitidos.');
  }

  if (parsed.username || parsed.password) {
    throw new ExternalUrlValidationError(
      rawUrl,
      'Credenciais embutidas na URL nao sao permitidas (protecao SSRF).',
    );
  }

  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new ExternalUrlValidationError(
      rawUrl,
      `Porta nao-padrao (${parsed.port}) bloqueada por politica anti-SSRF.`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  const blockedExactHosts = new Set([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '[::1]',
    'metadata.google.internal',
    'metadata',
    'instance-data',
  ]);

  if (
    blockedExactHosts.has(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost') ||
    host.endsWith('.lan') ||
    host.endsWith('.home') ||
    host.endsWith('.corp') ||
    isPrivateOrReservedIpv4(host) ||
    isPrivateOrReservedIpv6(host)
  ) {
    throw new ExternalUrlValidationError(
      rawUrl,
      'Hosts locais, metadados de nuvem ou redes privadas nao sao permitidos (protecao SSRF).',
    );
  }

  if (options.enforceAllowedMediaHost) {
    const allowedSet = new Set<string>(ALLOWED_MEDIA_SOURCE_DOMAINS);
    if (!allowedSet.has(host)) {
      throw new ExternalUrlValidationError(
        rawUrl,
        `Dominio "${host}" fora da lista de fontes de midia autorizadas (${ALLOWED_MEDIA_SOURCE_DOMAINS.join(', ')}).`,
      );
    }
  }

  return parsed;
}

export type RateLimitActionKey = 'create-run' | 'store-credential';

export interface RateLimitPolicy {
  action: RateLimitActionKey;
  maxRequests: number;
  windowMs: number;
}

export const RATE_LIMIT_POLICIES: Record<RateLimitActionKey, RateLimitPolicy> = {
  'create-run': {
    action: 'create-run',
    maxRequests: 10,
    windowMs: 60_000, // 10 disparos de run por minuto por usuário
  },
  'store-credential': {
    action: 'store-credential',
    maxRequests: 15,
    windowMs: 60_000, // 15 operações de credencial por minuto por usuário
  },
};

export interface RateLimitDecision {
  allowed: boolean;
  action: RateLimitActionKey;
  limit: number;
  remaining: number;
  retryAfterSec: number;
  resetAtIso: string;
}

/**
 * Rate Limiter Sliding-Window determinístico para proteger endpoints críticos
 * (`create-run` e `store-credential`) contra abuso.
 */
export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  public check(
    action: RateLimitActionKey,
    subjectId: string,
    nowMs: number = Date.now(),
    customPolicy?: Partial<RateLimitPolicy>,
  ): RateLimitDecision {
    const basePolicy = RATE_LIMIT_POLICIES[action];
    const maxRequests = customPolicy?.maxRequests ?? basePolicy.maxRequests;
    const windowMs = customPolicy?.windowMs ?? basePolicy.windowMs;

    const cleanSubject = subjectId.trim() || 'anonymous';
    const key = `${action}:${cleanSubject}`;
    const windowStart = nowMs - windowMs;

    const existing = this.buckets.get(key) ?? [];
    const activeTimestamps = existing.filter((ts) => ts > windowStart);

    if (activeTimestamps.length >= maxRequests) {
      const oldestInWindow = activeTimestamps[0] ?? nowMs;
      const resetAtMs = oldestInWindow + windowMs;
      const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
      this.buckets.set(key, activeTimestamps);

      return {
        allowed: false,
        action,
        limit: maxRequests,
        remaining: 0,
        retryAfterSec,
        resetAtIso: new Date(resetAtMs).toISOString(),
      };
    }

    activeTimestamps.push(nowMs);
    this.buckets.set(key, activeTimestamps);

    const remaining = Math.max(0, maxRequests - activeTimestamps.length);
    const resetAtMs = (activeTimestamps[0] ?? nowMs) + windowMs;

    return {
      allowed: true,
      action,
      limit: maxRequests,
      remaining,
      retryAfterSec: 0,
      resetAtIso: new Date(resetAtMs).toISOString(),
    };
  }

  public reset(action?: RateLimitActionKey, subjectId?: string): void {
    if (!action && !subjectId) {
      this.buckets.clear();
      return;
    }
    if (action && subjectId) {
      this.buckets.delete(`${action}:${subjectId.trim()}`);
      return;
    }
    if (action) {
      for (const k of this.buckets.keys()) {
        if (k.startsWith(`${action}:`)) {
          this.buckets.delete(k);
        }
      }
    }
  }
}

export const globalRateLimiter = new SlidingWindowRateLimiter();

export function buildRateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Reset': decision.resetAtIso,
  };
  if (!decision.allowed) {
    headers['Retry-After'] = String(decision.retryAfterSec);
  }
  return headers;
}
