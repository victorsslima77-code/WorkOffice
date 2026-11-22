import { z } from 'zod';

export const PlanTierSchema = z.enum(['free', 'pro', 'enterprise']);
export type PlanTier = z.infer<typeof PlanTierSchema>;

export const SignUpInputSchema = z.object({
  email: z.string().trim().email('Informe um e-mail valido.'),
  password: z
    .string()
    .min(8, 'A senha deve ter pelo menos 8 caracteres.')
    .max(128, 'A senha nao pode exceder 128 caracteres.'),
  displayName: z
    .string()
    .trim()
    .min(2, 'O nome de exibicao deve ter pelo menos 2 caracteres.')
    .max(60, 'O nome de exibicao nao pode exceder 60 caracteres.'),
});
export type SignUpInput = z.infer<typeof SignUpInputSchema>;

export const SignInInputSchema = z.object({
  email: z.string().trim().email('Informe um e-mail valido.'),
  password: z.string().min(1, 'Informe sua senha.'),
});
export type SignInInput = z.infer<typeof SignInInputSchema>;

export const ResetPasswordRequestSchema = z.object({
  email: z.string().trim().email('Informe um e-mail valido.'),
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const UpdatePasswordInputSchema = z
  .object({
    password: z
      .string()
      .min(8, 'A nova senha deve ter pelo menos 8 caracteres.')
      .max(128, 'A senha nao pode exceder 128 caracteres.'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'As senhas nao coincidem.',
    path: ['confirmPassword'],
  });
export type UpdatePasswordInput = z.infer<typeof UpdatePasswordInputSchema>;

export const ProfileSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string().nullable(),
  avatar_url: z.string().url().nullable().or(z.literal('')).nullable(),
  plan: PlanTierSchema.default('free'),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ProfileUpdateInputSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(2, 'O nome de exibicao deve ter pelo menos 2 caracteres.')
    .max(60, 'O nome de exibicao nao pode exceder 60 caracteres.'),
  avatar_url: z
    .string()
    .trim()
    .url('Informe uma URL valida para o avatar.')
    .nullable()
    .optional()
    .or(z.literal('')),
});
export type ProfileUpdateInput = z.infer<typeof ProfileUpdateInputSchema>;

export const PROTECTED_ROUTE_PREFIXES = ['/app', '/profile'] as const;
export const AUTH_GUEST_ONLY_ROUTES = ['/login', '/signup'] as const;

export interface RouteAccessDecision {
  allowed: boolean;
  redirectTo: string | null;
}

/**
 * Determina se uma rota pode ser acessada com base no estado de autenticacao
 * e aplica redirecionamento consistente para o middleware do App Router.
 */
export function evaluateRouteAccess(pathname: string, isAuthenticated: boolean): RouteAccessDecision {
  const isProtected = PROTECTED_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (isProtected && !isAuthenticated) {
    const encodedNext = encodeURIComponent(pathname);
    return {
      allowed: false,
      redirectTo: `/login?next=${encodedNext}`,
    };
  }

  const isGuestOnly = AUTH_GUEST_ONLY_ROUTES.some((route) => pathname === route);
  if (isGuestOnly && isAuthenticated) {
    return {
      allowed: false,
      redirectTo: '/app',
    };
  }

  return {
    allowed: true,
    redirectTo: null,
  };
}

/**
 * Verifica isolamento de propriedade (espelhando a politica RLS auth.uid() = ownerId).
 */
export function canAccessUserResource(authUserId: string | null | undefined, resourceOwnerId: string): boolean {
  if (!authUserId || !resourceOwnerId) {
    return false;
  }
  return authUserId === resourceOwnerId;
}
