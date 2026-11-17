// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { AdminServer } from '../src/admin/server';
import { createOwner, refreshPlatform, setBarLimit, setBarSuspended, setPlatformServer } from '../src/platform/actions';
import { platform, resetPlatform } from '../src/platform/platform';
import { hashSecret } from '../src/domain/pin';
import { freshDb } from './testDb';

/**
 * The app's own server client (src/admin/server.ts, src/platform/actions.ts)
 * against the real migrations: a fetch that turns Supabase's REST calls into
 * the same function calls, as the anon role (the publishable key).
 */

let pg: PGlite;
const config = { url: 'https://project.supabase.co', publishableKey: 'sb_publishable_test' };

function restFetch(db: PGlite): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect((init!.headers as Record<string, string>).apikey).toBe('sb_publishable_test');
    const fn = String(url).split('/rest/v1/rpc/')[1]!;
    const body = JSON.parse(String(init!.body ?? '{}')) as Record<string, unknown>;
    const keys = Object.keys(body);
    const args = keys.map((k, i) => `${k} => $${i + 1}${body[k] !== null && typeof body[k] === 'object' ? '::jsonb' : ''}`).join(', ');
    const values = keys.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]));
    try {
      const { rows } = await db.query<{ r: unknown }>(`select to_jsonb(public.${fn}(${args})) as r`, values);
      return new Response(JSON.stringify(rows[0]?.r ?? null), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ message: (error as Error).message }), { status: 400 });
    }
  }) as typeof fetch;
}

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

beforeEach(async () => {
  resetPlatform();
  pg = await freshDb();
  await pg.query(`select public.set_super_password('kaunta-live-2026')`);
  await pg.query('set role anon');
});
afterEach(async () => {
  setPlatformServer(null);
  await pg.close();
});

describe('the app against the server', () => {
  it('Kaunta adds an owner; the owner signs in, runs the bar and adds a manager; Kaunta limits and suspends', async () => {
    const kaunta = new AdminServer(config, restFetch(pg), memory(), true);
    expect(await kaunta.superSignIn('wrong-password')).toBe('wrong');
    expect(await kaunta.superSignIn('kaunta-live-2026')).toBe('ok');
    setPlatformServer(kaunta);

    const made = await createOwner({ name: 'Wambui', username: 'wambui', password: 'karibu-2026', barName: 'Wambui Bar', maxBars: 1 });
    if ('error' in made) throw new Error(made.error);
    // The screens' platform is the server's now.
    expect(platform().accounts.map((a) => a.username)).toContain('wambui');
    expect(platform().bars.find((b) => b.id === made.bar.id)).toMatchObject({ name: 'Wambui Bar', owner_account_id: made.account.id });

    const owner = new AdminServer(config, restFetch(pg), memory());
    expect(await owner.signIn('wambui', 'karibu-2026')).toMatchObject({ ok: true });
    expect((await owner.bars()).map((b) => b.name)).toEqual(['Wambui Bar']);
    expect((await owner.me()).bar_limit).toEqual({ used: 1, max: 1 });
    const pulled = await owner.forBar(made.bar.id).pull(null);
    expect(pulled.people.find((p) => p.id === pulled.me)).toMatchObject({ role: 'owner', login: 'password' });
    await expect(owner.createBar('Second')).rejects.toThrow('bar_limit');

    const manager = await owner.createManager([made.bar.id], { name: 'Amani', username: 'amani', pin: '2468' }, await hashSecret('2468'));
    expect('account' in manager).toBe(true);
    const amani = new AdminServer(config, restFetch(pg), memory());
    expect(await amani.signIn('amani', '2468')).toMatchObject({ ok: true });
    expect((await amani.bars())[0]).toMatchObject({ name: 'Wambui Bar', role: 'admin' });

    expect(await setBarLimit(made.account.id, 2)).toBeNull();
    expect((await owner.createBar('Second')).name).toBe('Second');

    await setBarSuspended(made.bar.id, true);
    expect(platform().bars.find((b) => b.id === made.bar.id)?.suspended_at).toBeTruthy();
    expect(await amani.bars()).toEqual([]);
    expect((await amani.me()).suspended).toEqual(['Wambui Bar']);
    // Kaunta still opens it, as Kaunta.
    expect((await kaunta.forBar(made.bar.id).pull(null)).me).toBe('kaunta');
    await setBarSuspended(made.bar.id, false);
    await refreshPlatform();
    expect((await amani.bars()).map((b) => b.name)).toEqual(['Wambui Bar']);

    owner.signOut();
    expect(owner.signedIn).toBe(false);
  });
});
