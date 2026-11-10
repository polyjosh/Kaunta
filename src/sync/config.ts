export interface ServerConfig {
  url: string;
  anonKey: string;
}

/**
 * The Supabase project, from `.env.local` (see `.env.example`). Without it the
 * app runs on the handoff sample data on this phone only, and nothing syncs.
 * The anon key is public by design: it can only call the three sync functions.
 */
export function serverConfig(env: Record<string, string | undefined> = import.meta.env): ServerConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, '');
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim();
  return url && anonKey ? { url, anonKey } : null;
}
