export interface ServerConfig {
  url: string;
  /**
   * Supabase's publishable key (`sb_publishable_…`), or a legacy `anon` key.
   * Public by design: it reaches only the functions the migrations grant to
   * the anon role (pairing, sync, sign-in and the session-checked entry
   * points). Never the secret key.
   */
  publishableKey: string;
}

/**
 * The Supabase project, from `.env.local` (see `.env.example`). Without it the
 * app runs as the browser demo (sample data, nothing syncs).
 */
export function serverConfig(env: Record<string, string | undefined> = import.meta.env): ServerConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, '');
  const publishableKey = (env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY)?.trim();
  return url && publishableKey ? { url, publishableKey } : null;
}

/** Headers for Supabase's REST API: the key in `apikey` only (new keys are not JWTs, so no Authorization). */
export function restHeaders(config: ServerConfig): Record<string, string> {
  return { apikey: config.publishableKey, 'Content-Type': 'application/json' };
}
