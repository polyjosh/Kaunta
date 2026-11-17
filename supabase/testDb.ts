import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/** Supabase has pgcrypto (accounts' passwords are hashed with it). */
const extensions = { pgcrypto };

const migrationsDir = new URL('./migrations/', import.meta.url);
/** Every migration, in file-name order, as `supabase db push` runs them. */
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'));
const seed = readFileSync(new URL('./seed.sql', import.meta.url), 'utf8');

let template: Promise<Blob | File> | null = null;

/** The roles Supabase provides, so the migration's grants run as they will there. */
const SUPABASE_ROLES = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  -- Supabase's auth.uid(): the signed-in user from the request's JWT. Tests sign in with signInAs().
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to public;
`;

/**
 * A real Postgres (PGlite) with the Supabase migration and seed applied.
 * Built once per test file, then copied for each test so tests are independent.
 */
export async function freshDb(): Promise<PGlite> {
  template ??= (async () => {
    const pg = new PGlite({ extensions });
    await pg.exec(SUPABASE_ROLES);
    for (const migration of migrations) await pg.exec(migration);
    await pg.exec(seed);
    const dump = await pg.dumpDataDir('none');
    await pg.close();
    return dump;
  })();
  return new PGlite({ loadDataDir: await template, extensions });
}

export async function call<T = Record<string, unknown>>(pg: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pg.query<{ r: T }>(sql, params);
  return rows[0]!.r;
}

/** A real Postgres with the migrations only, as a real bar's project starts (no seed.sql). */
export async function migratedDb(): Promise<PGlite> {
  const pg = new PGlite({ extensions });
  await pg.exec(SUPABASE_ROLES);
  for (const migration of migrations) await pg.exec(migration);
  return pg;
}

/** Pairs a phone as an existing device row and returns its token. */
export async function pairAs(pg: PGlite, deviceId = 'd_counter1', name = 'Counter 1', barId = 'bar_baraka'): Promise<string> {
  const code = await call<string>(pg, 'select public.create_pairing_code($1, $2, $3, $4) as r', [name, deviceId, 'p_njeri', barId]);
  const paired = await call<{ token: string }>(pg, 'select public.pair_device($1, $2, $3) as r', [code, name, 'test']);
  return paired.token;
}

/** Links a person to a Supabase auth user and acts as that user for the rest of the session. */
export async function signInAs(pg: PGlite, personId: string, userId = '00000000-0000-4000-8000-000000000001'): Promise<void> {
  await pg.query('update public.people set auth_user_id = $1 where id = $2', [userId, personId]);
  await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
}
