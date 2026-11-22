import { SUPABASE_TARGET_PROJECT_REF } from '@workoffice/shared';

export function getSupabaseEnv() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    `https://${SUPABASE_TARGET_PROJECT_REF}.supabase.co`;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'public-anon-key-not-configured';

  return { url, anonKey };
}
