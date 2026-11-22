import { describe, expect, it } from 'vitest';
import {
  buildRateLimitHeaders,
  ExternalUrlValidationError,
  SlidingWindowRateLimiter,
  validateSafeExternalUrl,
} from '../security.js';

describe('Etapa 9 — Hardening: Protecao Anti-SSRF e Rate Limiting', () => {
  it('bloqueia localhost, IPs privados, endpoints de cloud metadata (169.254.169.254), IPv6 mapeado, credenciais e portas nao-padrao', () => {
    const unsafeUrls = [
      'http://localhost:3000/api/secrets',
      'http://127.0.0.1/admin',
      'http://0.0.0.0/status',
      'http://10.0.0.15/internal',
      'http://172.20.0.5/worker',
      'http://192.168.1.1/router',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://100.100.100.200/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://[::1]/secret',
      'http://[::ffff:127.0.0.1]/secret',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://2130706433/decimal-ip-bypass',
      'http://0x7f000001/hex-ip-bypass',
      'http://0177.0.0.1/octal-ip-bypass',
      'https://user:secretpass@www.youtube.com/watch?v=abc12345',
      'https://www.youtube.com:8443/watch?v=abc12345',
      'file:///etc/passwd',
      'gopher://127.0.0.1:6379/_INFO',
      'http://internal-db.corp/dump',
    ];

    for (const badUrl of unsafeUrls) {
      expect(() => validateSafeExternalUrl(badUrl)).toThrow(ExternalUrlValidationError);
    }
  });

  it('permite URLs publicas seguras e restringe ao dominio do YouTube quando enforceAllowedMediaHost=true', () => {
    const validYt = validateSafeExternalUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      enforceAllowedMediaHost: true,
    });
    expect(validYt.hostname).toBe('www.youtube.com');

    const validShortYt = validateSafeExternalUrl('https://youtu.be/dQw4w9WgXcQ', {
      enforceAllowedMediaHost: true,
    });
    expect(validShortYt.hostname).toBe('youtu.be');

    // Dominio externo valido em modo geral, mas bloqueado para download de midia (yt-dlp)
    expect(() =>
      validateSafeExternalUrl('https://evil-untrusted-host.example.com/video.mp4', {
        enforceAllowedMediaHost: true,
      }),
    ).toThrow(ExternalUrlValidationError);
  });

  it('aplica rate limiting sliding-window em create-run e store-credential com cabecalhos Retry-After', () => {
    const limiter = new SlidingWindowRateLimiter();
    const userId = 'user-123';
    const baseTime = 1_700_000_000_000;

    // 10 requisicoes permitidas para create-run em 60s
    for (let i = 1; i <= 10; i++) {
      const decision = limiter.check('create-run', userId, baseTime + i * 100);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(10 - i);
    }

    // 11a requisicao dentro da janela deve ser bloqueada com 429
    const blocked = limiter.check('create-run', userId, baseTime + 2_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);

    const headers = buildRateLimitHeaders(blocked);
    expect(headers['X-RateLimit-Limit']).toBe('10');
    expect(headers['X-RateLimit-Remaining']).toBe('0');
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);

    // Apos 61 segundos, a janela desliza e permite novamente
    const afterWindow = limiter.check('create-run', userId, baseTime + 62_000);
    expect(afterWindow.allowed).toBe(true);
  });
});
