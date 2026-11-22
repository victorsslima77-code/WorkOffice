import { describe, expect, it } from 'vitest';
import { evaluateRouteAccess } from '@workoffice/shared';
import { getSupabaseEnv } from '../lib/supabase/config';

describe('@workoffice/web — Supabase Env & Guardas de Rota', () => {
  it('resolve a URL padrao do projeto Supabase jphdogyddahozpcgktdz', () => {
    const env = getSupabaseEnv();
    expect(env.url).toContain('jphdogyddahozpcgktdz.supabase.co');
  });

  it('bloqueia acesso nao autenticado a sub-rotas protegidas (/app/*, /profile/*)', () => {
    const decision = evaluateRouteAccess('/app/office-1', false);
    expect(decision.allowed).toBe(false);
    expect(decision.redirectTo).toBe('/login?next=%2Fapp%2Foffice-1');
  });
});
