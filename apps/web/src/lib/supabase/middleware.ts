import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { evaluateRouteAccess } from '@workoffice/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseEnv } from './config';

export async function updateSessionAndGuardRoutes(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const { url, anonKey } = getSupabaseEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  let isAuthenticated = false;
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    isAuthenticated = Boolean(user);
  } catch {
    isAuthenticated = false;
  }

  const decision = evaluateRouteAccess(request.nextUrl.pathname, isAuthenticated);
  if (!decision.allowed && decision.redirectTo) {
    const redirectUrl = new URL(decision.redirectTo, request.url);
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
