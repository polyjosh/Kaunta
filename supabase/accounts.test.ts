// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { call, freshDb, pairAs } from './testDb';

/**
 * Accounts and Kaunta on the server (20261121000000_kaunta_accounts.sql):
 * owners and managers sign in with a username, Kaunta with its password; the
 * app calls kaunta_admin / kaunta_super with the session.
 */

let pg: PGlite;
const HASH = 'pbkdf2-sha256$100000$c2FsdA==$aGFzaA==';

const superCall = <T = any>(session: string, fn: string, args: object = {}) =>
  call<T>(pg, 'select public.kaunta_super($1, $2, $3::jsonb) as r', [session, fn, JSON.stringify(args)]);
const adminCall = <T = any>(session: string, fn: string, args: object = {}) =>
  call<T>(pg, 'select public.kaunta_admin($1, $2, $3::jsonb) as r', [session, fn, JSON.stringify(args)]);
const signIn = (username: string, secret: string) => call<any>(pg, 'select public.account_sign_in($1, $2) as r', [username, secret]);

async function kaunta(): Promise<string> {
  await pg.query(`select public.set_super_password('kaunta-test-2026')`);
  const r = await call<any>(pg, 'select public.super_sign_in($1) as r', ['kaunta-test-2026']);
  return r.token;
}

async function owner(session: string, username = 'wambui', extra: object = {}) {
  const made = await superCall(session, 'super_create_owner', {
    name: 'Wambui', username, password: 'karibu-2026', counter_hash: HASH, bar_name: 'Wambui Bar', ...extra,
  });
  const signed = await signIn(username, 'karibu-2026');
  return { made, token: signed.token as string, barId: made.bar.id as string };
}

beforeEach(async () => {
  pg = await freshDb();
});
afterEach(() => pg.close());

describe('Kaunta', () => {
  it('has no way in until its password is set; then signs in, and 5 wrong tries lock it', async () => {
    expect(await call(pg, 'select public.super_sign_in($1) as r', ['anything'])).toEqual({ ok: false, reason: 'not_set' });
    const token = await kaunta();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < 4; i++) expect((await call<any>(pg, 'select public.super_sign_in($1) as r', ['wrong-one'])).reason).toBe('wrong');
    expect((await call<any>(pg, 'select public.super_sign_in($1) as r', ['wrong-one'])).reason).toBe('locked');
    expect((await call<any>(pg, 'select public.super_sign_in($1) as r', ['kaunta-test-2026'])).reason).toBe('locked');
    await expect(superCall('not-a-session', 'super_platform')).rejects.toThrow('signed_out');
  });

  it('creates an owner with their first bar; they may open one bar until Kaunta allows more', async () => {
    const k = await kaunta();
    const { made, token, barId } = await owner(k, 'wambui', { bar_code: 'WAMBUI1' });
    expect(made.account).toMatchObject({ username: 'wambui', secret: 'password', max_bars: 1, pin_set_by: 'kaunta' });
    expect(made.bar).toMatchObject({ name: 'Wambui Bar', counter_code: 'WAMBUI1', created_by: 'kaunta' });
    expect(await adminCall(token, 'admin_bars')).toEqual([{ id: barId, name: 'Wambui Bar', role: 'owner', person_id: expect.any(String), counter_code: 'WAMBUI1' }]);
    expect((await adminCall(token, 'admin_me')).bar_limit).toEqual({ used: 1, max: 1 });
    // Her counters check her password offline with the app's hash.
    expect((await pg.query<any>(`select pin_hash, login from public.people where bar_id = $1`, [barId])).rows[0]).toEqual({ pin_hash: HASH, login: 'password' });
    await expect(adminCall(token, 'admin_create_bar', { p_name: 'Second' })).rejects.toThrow('bar_limit');
    await superCall(k, 'super_set_bar_limit', { account_id: made.account.id, max: 2 });
    expect((await adminCall(token, 'admin_create_bar', { p_name: 'Second' })).name).toBe('Second');
    expect((await adminCall(token, 'admin_bars')).map((b: any) => b.name)).toEqual(['Second', 'Wambui Bar']);
    // Taken usernames and codes are refused.
    expect((await superCall(k, 'super_create_owner', { name: 'X', username: 'wambui', password: 'karibu-2026', counter_hash: HASH, bar_name: 'X' })).error).toBe('usernameTaken');
    expect((await superCall(k, 'super_create_owner', { name: 'X', username: 'xowner', password: 'karibu-2026', counter_hash: HASH, bar_name: 'X', bar_code: 'wambui-1' })).error).toBe('taken');
    expect((await superCall(k, 'super_platform')).accounts.map((a: any) => a.username)).toEqual(['wambui']);
  });
});

describe('owners and managers', () => {
  it('a wrong password counts toward a lock; an unknown name says nothing more', async () => {
    const k = await kaunta();
    await owner(k);
    expect(await signIn('nobody', 'x')).toEqual({ ok: false, reason: 'wrong', tries_left: null });
    for (let i = 4; i >= 1; i--) expect(await signIn('wambui', 'nope')).toEqual({ ok: false, reason: 'wrong', tries_left: i });
    expect((await signIn('wambui', 'nope')).reason).toBe('locked');
    expect((await signIn('wambui', 'karibu-2026')).reason).toBe('locked');
    await superCall(k, 'super_reset_secret', { account_id: (await superCall(k, 'super_platform')).accounts[0].id, secret: 'new-pass-2026', counter_hash: HASH });
    expect((await signIn('wambui', 'new-pass-2026')).ok).toBe(true);
  });

  it('changes their own password; their counters get the new hash', async () => {
    const k = await kaunta();
    const { token, barId } = await owner(k);
    expect(await adminCall(token, 'admin_change_secret', { p_current: 'wrong', p_next: 'other-2026', p_counter_hash: HASH })).toEqual({ error: 'current' });
    expect(await adminCall(token, 'admin_change_secret', { p_current: 'karibu-2026', p_next: 'short', p_counter_hash: HASH })).toEqual({ error: 'invalid' });
    const NEW = 'pbkdf2-sha256$100000$bmV3$bmV3';
    expect(await adminCall(token, 'admin_change_secret', { p_current: 'karibu-2026', p_next: 'other-2026', p_counter_hash: NEW })).toEqual({ ok: true });
    expect((await signIn('wambui', 'karibu-2026')).ok).toBe(false);
    expect((await signIn('wambui', 'other-2026')).account.pin_set_by).toBe('self');
    expect((await pg.query<any>(`select pin_hash from public.people where bar_id = $1`, [barId])).rows[0].pin_hash).toBe(NEW);
  });

  it('an owner adds a manager to two of their bars, then takes them off one', async () => {
    const k = await kaunta();
    const { made, token, barId } = await owner(k);
    await superCall(k, 'super_set_bar_limit', { account_id: made.account.id, max: null });
    const second = await adminCall(token, 'admin_create_bar', { p_name: 'Second' });
    const created = await adminCall(token, 'admin_create_manager', { p_bar_ids: [barId, second.id], p_name: 'Amani', p_username: 'amani', p_pin: '2468', p_counter_hash: HASH });
    expect(created.account).toMatchObject({ username: 'amani', secret: 'pin' });
    const amani = (await signIn('amani', '2468')).token;
    expect((await adminCall(amani, 'admin_bars')).map((b: any) => [b.name, b.role])).toEqual([['Second', 'admin'], ['Wambui Bar', 'admin']]);
    // Audited in each bar by the owner.
    expect((await pg.query(`select 1 from public.audit_events where kind = 'person_saved' and bar_id in ($1, $2)`, [barId, second.id])).rows).toHaveLength(2);
    // Managers can't add managers, or start bars.
    expect((await adminCall(amani, 'admin_create_manager', { p_bar_ids: [barId], p_name: 'X', p_username: 'xman', p_pin: '1111', p_counter_hash: HASH })).error).toBe('notOwner');
    await expect(adminCall(amani, 'admin_create_bar', { p_name: 'Mine' })).rejects.toThrow('not_owner');

    expect(await adminCall(token, 'admin_remove_manager', { p_account: created.account.id, p_bar: second.id })).toEqual({ ok: true });
    expect((await adminCall(amani, 'admin_bars')).map((b: any) => b.name)).toEqual(['Wambui Bar']);
    await expect(adminCall(amani, 'admin_pull', { p_bar_id: second.id })).rejects.toThrow('not_admin');
    expect(await adminCall(token, 'admin_add_manager', { p_account: created.account.id, p_bar: second.id })).toEqual({ ok: true });
    expect(await adminCall(token, 'admin_add_manager', { p_account: created.account.id, p_bar: second.id })).toEqual({ error: 'already' });
    // The owner's platform: her account, Amani, both bars, who runs them.
    const plat = await adminCall(token, 'admin_platform');
    expect(plat.accounts.map((a: any) => a.username).sort()).toEqual(['amani', 'wambui']);
    expect(plat.members).toHaveLength(4);
  });

  it('cannot take another owner’s manager', async () => {
    const k = await kaunta();
    const a = await owner(k, 'ownera');
    const b = await owner(k, 'ownerb');
    const m = await adminCall(a.token, 'admin_create_manager', { p_bar_ids: [a.barId], p_name: 'Amani', p_username: 'amani', p_pin: '2468', p_counter_hash: HASH });
    expect(await adminCall(b.token, 'admin_add_manager', { p_account: m.account.id, p_bar: b.barId })).toEqual({ error: 'notManager' });
    expect(await adminCall(b.token, 'admin_add_manager', { p_account: m.account.id, p_bar: a.barId })).toEqual({ error: 'notOwner' });
  });
});

describe('a suspended bar', () => {
  it('shuts out its owner, managers and phones until Kaunta gives access back; Kaunta still gets in', async () => {
    const k = await kaunta();
    const { token, barId } = await owner(k);
    await superCall(k, 'super_set_bar_suspended', { bar_id: 'bar_baraka', suspended: true });
    await superCall(k, 'super_set_bar_suspended', { bar_id: barId, suspended: true });
    expect(await adminCall(token, 'admin_bars')).toEqual([]);
    expect((await adminCall(token, 'admin_me')).suspended).toEqual(['Wambui Bar']);
    await expect(adminCall(token, 'admin_pull', { p_bar_id: barId })).rejects.toThrow('bar_suspended');
    // The sample bar's phone.
    const phone = await pairAs(pg);
    expect(await call(pg, 'select public.sync_pull($1, null) as r', [phone])).toEqual({ error: 'bar_suspended' });
    expect(await call(pg, `select public.sync_push($1, '[]'::jsonb) as r`, [phone])).toEqual({ error: 'bar_suspended' });
    expect(await call(pg, 'select public.pair_with_bar_code($1) as r', ['BRKA-PUB2'])).toEqual({ error: 'bar_suspended' });
    // Kaunta, as the person 'kaunta'.
    expect((await superCall(k, 'admin_pull', { p_bar_id: barId })).me).toBe('kaunta');

    await superCall(k, 'super_set_bar_suspended', { bar_id: barId, suspended: false });
    await superCall(k, 'super_set_bar_suspended', { bar_id: 'bar_baraka', suspended: false });
    expect((await adminCall(token, 'admin_pull', { p_bar_id: barId })).me).toEqual(expect.any(String));
    expect((await call<any>(pg, 'select public.sync_pull($1, null) as r', [phone])).error).toBeUndefined();
  });
});

describe('Kaunta in a bar', () => {
  it('sets a staff PIN and suspends someone as the person ‘kaunta’ (so the app can leave it out of owners’ logs)', async () => {
    const k = await kaunta();
    const res = await superCall(k, 'admin_push', {
      p_bar_id: 'bar_baraka',
      p_events: [
        { id: 'ke1', type: 'pin_changed', payload: { person_id: 'p_otieno', pin_hash: HASH, pin_code: '1122' }, created_at: new Date().toISOString() },
        { id: 'ke2', type: 'person_suspended', payload: { person_id: 'p_kiprop' }, created_at: new Date().toISOString() },
      ],
    });
    expect(res.results.map((r: any) => r.status)).toEqual(['applied', 'applied']);
    expect((await pg.query<any>(`select actor_id from public.audit_events where event_id in ('ke1', 'ke2')`)).rows).toEqual([{ actor_id: 'kaunta' }, { actor_id: 'kaunta' }]);
    expect((await pg.query<any>(`select pin_code from public.people where id = 'p_otieno'`)).rows[0].pin_code).toBe('1122');
    expect((await superCall(k, 'admin_set_bar_code', { p_bar_id: 'bar_baraka', p_code: 'KAUNTA9' })).counter_code).toBe('KAUNTA9');
  });
});

describe('what the app’s key can reach', () => {
  it('only the entry points: not the functions behind them, nor the accounts', async () => {
    await pg.query('set role anon');
    for (const sql of [
      `select public.admin_call('admin_bars', '{}')`,
      `select public.super_platform()`,
      `select public.set_super_password('hijack-2026')`,
      `select * from public.accounts`,
      `select public.sync_pull_v3('x', null)`,
    ]) {
      await expect(pg.query(sql)).rejects.toThrow(/permission denied/);
    }
    expect((await pg.query<any>(`select public.account_sign_in('nobody', 'x') as r`)).rows[0].r.ok).toBe(false);
  });
});
