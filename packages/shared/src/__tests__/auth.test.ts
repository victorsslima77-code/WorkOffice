import { describe, expect, it } from 'vitest';
import {
  canAccessUserResource,
  evaluateRouteAccess,
  ProfileUpdateInputSchema,
  SignInInputSchema,
  SignUpInputSchema,
  UpdatePasswordInputSchema,
} from '../auth.js';

describe('@workoffice/shared — Auth & RLS Isolation', () => {
  it('valida dados corretos de Sign Up com email, senha e displayName', () => {
    const parsed = SignUpInputSchema.safeParse({
      email: '  dev@workoffice.ai ',
      password: 'Password123!',
      displayName: 'Alice Retro',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe('dev@workoffice.ai');
    }
  });

  it('rejeita Sign Up com senha curta ou email invalido', () => {
    const parsed = SignUpInputSchema.safeParse({
      email: 'email-invalido',
      password: '123',
      displayName: 'A',
    });
    expect(parsed.success).toBe(false);
  });

  it('valida Sign In e UpdatePassword com confirmacao de senha', () => {
    expect(
      SignInInputSchema.safeParse({
        email: 'user@workoffice.ai',
        password: 'secretPassword',
      }).success,
    ).toBe(true);

    expect(
      UpdatePasswordInputSchema.safeParse({
        password: 'newSecretPassword123',
        confirmPassword: 'differentPassword',
      }).success,
    ).toBe(false);
  });

  it('valida atualizacao de perfil do usuario', () => {
    const valid = ProfileUpdateInputSchema.safeParse({
      display_name: 'Roteirista Chefe',
      avatar_url: 'https://example.com/avatar.png',
    });
    expect(valid.success).toBe(true);
  });

  it('protege rotas autenticadas (/app, /profile) e redireciona visitantes para /login', () => {
    expect(evaluateRouteAccess('/app', false)).toEqual({
      allowed: false,
      redirectTo: '/login?next=%2Fapp',
    });
    expect(evaluateRouteAccess('/profile', false)).toEqual({
      allowed: false,
      redirectTo: '/login?next=%2Fprofile',
    });
    expect(evaluateRouteAccess('/app', true)).toEqual({
      allowed: true,
      redirectTo: null,
    });
  });

  it('redireciona usuarios ja autenticados de /login e /signup para /app', () => {
    expect(evaluateRouteAccess('/login', true)).toEqual({
      allowed: false,
      redirectTo: '/app',
    });
    expect(evaluateRouteAccess('/signup', true)).toEqual({
      allowed: false,
      redirectTo: '/app',
    });
  });

  it('garante isolamento de recursos por usuario (auth.uid() === resourceOwnerId)', () => {
    const userA = '11111111-1111-1111-1111-111111111111';
    const userB = '22222222-2222-2222-2222-222222222222';
    expect(canAccessUserResource(userA, userA)).toBe(true);
    expect(canAccessUserResource(userA, userB)).toBe(false);
    expect(canAccessUserResource(null, userA)).toBe(false);
  });
});
