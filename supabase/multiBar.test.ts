// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { presets } from '../src/domain/presets';
import { call, freshDb, pairAs, signInAs } from './testDb';

let pg: PGlite;
let n = 0;
const OWNER = '00000000-0000-4000-8000-000000000001';

const pull = (bar: string, since: string | null = null) => call<Record<string, any>>(pg, 'select public.admin_pull($1, $2) as r', [bar, since]);
const push = (bar: string, events: object[]) =>
  call<{ results: { id: string; status: string; reason: string | null }[] }>(pg, 'select public.admin_push($1, $2::jsonb) as r', [bar, JSON.stringify(events)]);
const ev = (type: string, payload: object) => ({ id: `ae_${++n}_${Math.random().toString(36).slice(2, 8)}`, type, payload, created_at: new Date().toISOString() });
const bars = () => call<{ id: string; name: string; role: string }[]>(pg, 'select public.admin_bars() as r');
const createBar = (name: string) => call<{ id: string; name: string; role: string; person_id: string; counter_code?: string }>(pg, 'select public.admin_create_bar($1) as r', [name]);

/** The sample bar (Baraka Pub), its owner Njeri signed in, and a second bar she starts. */
beforeEach(async () => {
  pg = await freshDb();
  await signInAs(pg, 'p_njeri', OWNER);
});
afterEach(() => pg.close());

describe('an owner with more than one bar', () => {
  it('lists her bars, starts another, and is its owner there', async () => {
    expect(await bars()).toEqual([{ id: 'bar_baraka', name: 'Baraka Pub', role: 'owner', person_id: 'p_njeri', counter_code: 'BRKAPUB2' }]);
    const lounge = await createBar('  Baraka Lounge ');
    expect(lounge).toMatchObject({ name: 'Baraka Lounge', role: 'owner' });
    expect((await bars()).map((b) => b.name)).toEqual(['Baraka Lounge', 'Baraka Pub']);

    const there = await pull(lounge.id);
    expect(there.me).toBe(lounge.person_id);
    expect(there.bar).toEqual([expect.objectContaining({ id: lounge.id, name: 'Baraka Lounge', day_start: '06:00' })]);
    expect(there.people.map((p: { name: string; role: string }) => [p.name, p.role])).toEqual([['Njeri', 'owner']]);
    expect(there.products).toEqual([]);
    expect(there.categories).toHaveLength(5);
    expect(there.auditEvents.map((a: { kind: string }) => a.kind)).toEqual(['bar_created']);
  });

  it('each bar sees only its own rows', async () => {
    const lounge = await createBar('Baraka Lounge');
    const added = await push(lounge.id, presets(lounge.id).slice(0, 3).map((p) => ev('product_saved', { product: p.product, sizes: p.sizes, before: null })));
    expect(added.results.every((r) => r.status === 'applied')).toBe(true);

    const pub = await pull('bar_baraka');
    expect(pub.bar.map((b: { id: string }) => b.id)).toEqual(['bar_baraka']);
    expect(pub.products.some((p: { id: string }) => p.id.startsWith(lounge.id))).toBe(false);
    expect(pub.orders.length).toBeGreaterThan(0);

    const loungeRows = await pull(lounge.id);
    expect(loungeRows.products.map((p: { name: string }) => p.name)).toEqual(['Tusker Lager', 'White Cap', 'Guinness']);
    expect(loungeRows.orders).toEqual([]);
    expect(loungeRows.approvals).toEqual([]);
    expect(loungeRows.devices).toEqual([]);
  });

  it('a change aimed at another bar’s row is refused and changes nothing', async () => {
    const lounge = await createBar('Baraka Lounge');
    const { rows } = await pg.query<{ product: object; sizes: object[] }>(
      `select to_jsonb(p) - 'updated_at' - 'bar_id' as product, (select jsonb_agg(to_jsonb(s) - 'updated_at' - 'bar_id') from public.sizes s where s.product_id = p.id) as sizes
       from public.products p where id = 'tusker'`,
    );
    const hijack = { product: { ...rows[0]!.product, name: 'Mine now' }, sizes: rows[0]!.sizes, before: null };
    const answer = await push(lounge.id, [ev('product_saved', hijack)]);
    expect(answer.results[0]!.status).toBe('rejected');
    expect((await pg.query<{ name: string; bar_id: string }>(`select name, bar_id from public.products where id = 'tusker'`)).rows[0]).toEqual({ name: 'Tusker Lager', bar_id: 'bar_baraka' });
  });

  it('an admin of one bar is not an admin of the other', async () => {
    const lounge = await createBar('Baraka Lounge');
    // Chebet is an admin at Baraka Pub only.
    await signInAs(pg, 'p_chebet', '00000000-0000-4000-8000-000000000003');
    expect((await bars()).map((b) => b.id)).toEqual(['bar_baraka']);
    expect((await pull('bar_baraka')).me).toBe('p_chebet');
    await expect(pull(lounge.id)).rejects.toThrow('not_admin');
    await expect(push(lounge.id, [])).rejects.toThrow('not_admin');
    // Only owners start bars.
    await expect(createBar('Chebet’s place')).rejects.toThrow('not_owner');
  });

  it('a bar needs a name', async () => {
    await expect(createBar('   ')).rejects.toThrow('name_required');
  });
});

describe('counter phones belong to the bar that paired them', () => {
  it('a phone paired by the second bar pulls only that bar, and numbers its own day from #001', async () => {
    const lounge = await createBar('Baraka Lounge');
    await push(lounge.id, presets(lounge.id).slice(0, 1).map((p) => ev('product_saved', { product: p.product, sizes: p.sizes, before: null })));
    const made = await call<{ code: string }>(pg, 'select public.admin_create_pairing_code($1, $2) as r', [lounge.id, 'Lounge counter']);
    const paired = await call<{ device_id: string; token: string }>(pg, 'select public.pair_device($1, $2, $3) as r', [made.code, null, 'test']);

    const rows = await call<Record<string, any>>(pg, 'select public.sync_pull($1, null) as r', [paired.token]);
    expect(rows.bar.map((b: { name: string }) => b.name)).toEqual(['Baraka Lounge']);
    expect(rows.people.map((p: { name: string }) => p.name)).toEqual(['Njeri']);
    expect(rows.people[0]).not.toHaveProperty('auth_user_id');
    expect(rows.products.map((p: { id: string }) => p.id)).toEqual([`${lounge.id}:tusker`]);
    expect(rows.orders).toEqual([]);
    expect(rows.devices.map((d: { id: string }) => d.id)).toEqual([paired.device_id]);

    // Baraka Pub already has #001…#048 on the sample day; the lounge starts its own count.
    const at = '2026-11-10T19:30:00.000Z';
    const order = { id: 'o_lounge_1', short_no: '#001', short_no_provisional: true, label: '', server_id: rows.people[0].id, business_day: '2026-11-10', status: 'open', recorded_by: rows.people[0].id, device_id: paired.device_id, created_at: at };
    const line = { id: 'o_lounge_1_l0', order_id: 'o_lounge_1', product_id: `${lounge.id}:tusker`, size_id: `${lounge.id}:tusker_500`, qty: 1, unit_price_kes: 300, status: 'active', keg_id: null, recorded_by: order.recorded_by, device_id: paired.device_id, created_at: at };
    const sizeId = rows.sizes[0].id;
    line.size_id = sizeId;
    const sent = await call<{ results: { status: string; result: { short_no: string } }[] }>(pg, 'select public.sync_push($1, $2::jsonb) as r', [
      paired.token,
      JSON.stringify([{ id: 'ev_lounge_1', type: 'order_recorded', device_id: paired.device_id, recorded_by: order.recorded_by, created_at: at, payload: { order, lines: [line], payments: [] } }]),
    ]);
    expect(sent.results[0]).toMatchObject({ status: 'applied', result: { short_no: '#001' } });
    const { rows: stored } = await pg.query<{ bar_id: string }>(`select bar_id from public.orders where id = 'o_lounge_1'`);
    expect(stored[0]!.bar_id).toBe(lounge.id);
    // And the pub's phones never see it.
    const pubToken = await pairAs(pg);
    const pubRows = await call<Record<string, any>>(pg, 'select public.sync_pull($1, null) as r', [pubToken]);
    expect(pubRows.orders.some((o: { id: string }) => o.id === 'o_lounge_1')).toBe(false);
    expect(pubRows.bar.map((b: { id: string }) => b.id)).toEqual(['bar_baraka']);
  });

  it('a pairing code from the SQL editor must say which bar once there are two', async () => {
    await createBar('Baraka Lounge');
    await expect(pg.query(`select public.create_pairing_code('Counter 9')`)).rejects.toThrow('which bar');
    const code = await call<string>(pg, `select public.create_pairing_code('Counter 9', null, null, 'bar_baraka') as r`);
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe('the bar code: how a counter phone finds its bar', () => {
  const pairWithCode = (code: string, name: string | null = null) =>
    call<{ device_id?: string; token?: string; error?: string }>(pg, 'select public.pair_with_bar_code($1, $2, $3) as r', [code, name, 'test']);

  it('every bar has one: the sample bar’s is fixed, a new bar gets a fresh one', async () => {
    expect((await pull('bar_baraka')).bar[0].counter_code).toBe('BRKAPUB2');
    const lounge = await createBar('Baraka Lounge');
    expect(lounge.counter_code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    expect(lounge.counter_code).not.toBe('BRKAPUB2');
    expect((await pull(lounge.id)).bar[0].counter_code).toBe(lounge.counter_code);
  });

  it('typed on a new phone (any case, with or without the dash), it joins that bar', async () => {
    const lounge = await createBar('Baraka Lounge');
    const code = lounge.counter_code as string;
    const joined = await pairWithCode(`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`);
    expect(joined.token).toBeTruthy();
    const rows = await call<Record<string, any>>(pg, 'select public.sync_pull($1, null) as r', [joined.token]);
    expect(rows.bar.map((b: { id: string }) => b.id)).toEqual([lounge.id]);
    expect(rows.devices).toEqual([expect.objectContaining({ id: joined.device_id, name: 'Counter 1' })]);
    // The owner sees the new phone, and the audit log says how it joined.
    const there = await pull(lounge.id);
    expect(there.devices.map((d: { id: string }) => d.id)).toEqual([joined.device_id]);
    expect(there.auditEvents.find((a: { kind: string }) => a.kind === 'device_paired').detail).toMatchObject({ by: 'bar_code' });
  });

  it('a wrong code joins nothing and counts toward the pairing limit', async () => {
    expect(await pairWithCode('ZZZZ-ZZZZ')).toEqual({ error: 'invalid_code' });
    for (let i = 0; i < 19; i++) await pairWithCode('ZZZZ-ZZZZ');
    expect(await pairWithCode('BRKA-PUB2')).toEqual({ error: 'too_many_attempts' });
  });

  it('the owner can replace it: the old code stops working, phones already in stay in', async () => {
    const before = await pairWithCode('BRKAPUB2');
    const fresh = await call<{ counter_code: string }>(pg, 'select public.admin_new_bar_code($1) as r', ['bar_baraka']);
    expect(fresh.counter_code).not.toBe('BRKAPUB2');
    expect(await pairWithCode('BRKAPUB2')).toEqual({ error: 'invalid_code' });
    expect((await pairWithCode(fresh.counter_code)).token).toBeTruthy();
    const still = await call<Record<string, any>>(pg, 'select public.sync_pull($1, null) as r', [before.token]);
    expect(still.bar[0].counter_code).toBe(fresh.counter_code);
    // Admins who are not owners cannot.
    await signInAs(pg, 'p_chebet', '00000000-0000-4000-8000-000000000003');
    await expect(call(pg, 'select public.admin_new_bar_code($1) as r', ['bar_baraka'])).rejects.toThrow('not_owner');
  });

  it('only a phone with the code can call it: the anon key may, but it reveals nothing else', async () => {
    await pg.exec('set role anon');
    expect((await pairWithCode('BRKAPUB2')).token).toBeTruthy();
    await expect(pg.query('select * from public.bar')).rejects.toThrow(/permission denied/);
    await expect(call(pg, 'select public.admin_new_bar_code($1) as r', ['bar_baraka'])).rejects.toThrow(/permission denied/);
    await pg.exec('reset role');
  });
});

describe('an owner chooses the bar code', () => {
  const setCode = (bar: string, code: string) => call<{ counter_code?: string; error?: string }>(pg, 'select public.admin_set_bar_code($1, $2) as r', [bar, code]);

  it('takes their own code when no other bar has it, look-alikes included', async () => {
    const lounge = await createBar('Baraka Lounge');
    expect(await setCode(lounge.id, 'baraka-01')).toEqual({ counter_code: 'BARAKA01' });
    // The pub may not take it, nor its look-alike (O for 0, I/L for 1).
    expect(await setCode('bar_baraka', 'BARAKA01')).toEqual({ error: 'taken' });
    expect(await setCode('bar_baraka', 'BARAKAOI')).toEqual({ error: 'taken' });
    // Too short, too long, or digits only (a pairing code's shape) are refused.
    expect(await setCode('bar_baraka', 'AB12')).toEqual({ error: 'invalid' });
    expect(await setCode('bar_baraka', '123456')).toEqual({ error: 'invalid' });
    expect(await setCode('bar_baraka', 'ABCDEFGHJKMNP')).toEqual({ error: 'invalid' });
    // Its own code again is fine.
    expect(await setCode(lounge.id, 'BARAKA01')).toEqual({ counter_code: 'BARAKA01' });
    // A phone typing the look-alike still finds the bar.
    const joined = await call<{ token?: string }>(pg, 'select public.pair_with_bar_code($1, null, null) as r', ['barakaoi']);
    expect(joined.token).toBeTruthy();
  });

  it('only the owner', async () => {
    await signInAs(pg, 'p_chebet', '00000000-0000-4000-8000-000000000003');
    await expect(setCode('bar_baraka', 'CHEBET01')).rejects.toThrow('not_owner');
  });
});
