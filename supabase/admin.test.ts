// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { call, freshDb, pairAs, signInAs } from './testDb';

let pg: PGlite;
let n = 0;
const id = (prefix: string) => `${prefix}_${++n}_${Math.random().toString(36).slice(2, 8)}`;
const now = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const one = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0]!;

interface AdminResult {
  id: string;
  status: 'applied' | 'rejected';
  reason: string | null;
  duplicate: boolean;
}

const adminEvent = (type: string, payload: object, createdAt = now()) => ({ id: id('ae'), type, payload, created_at: createdAt });
const push = (events: object[]) => call<{ results: AdminResult[] }>(pg, "select public.admin_push('bar_baraka', $1::jsonb) as r", [JSON.stringify(events)]);
const pushOne = async (type: string, payload: object, createdAt?: string) => (await push([adminEvent(type, payload, createdAt)])).results[0]!;
const pull = (since: string | null = null) => call<Record<string, any>>(pg, "select public.admin_pull('bar_baraka', $1) as r", [since]);
const stock = async (product: string) => (await one<{ stock_qty: number }>('select stock_qty from public.products where id = $1', [product])).stock_qty;

/** #039's Guinness waits on a void request, as in the sample night. */
async function waitingVoid(kind = 'void') {
  await pg.query(`update public.lines set status = 'void_pending' where id = 'o_039_l0'`);
  await pg.query(
    `insert into public.approvals (id, kind, target, amount_kes, reason_code, requested_by, device_id, requested_at)
     values ('a1', $1, '{"order_id":"o_039","line_ids":["o_039_l0"],"whole_order":false}', 330, 'changed', 'p_otieno', 'd_counter1', now())`,
    [kind],
  );
}

beforeEach(async () => {
  pg = await freshDb();
  await signInAs(pg, 'p_njeri');
});
afterEach(() => pg.close());

describe('who may call it', () => {
  it('a signed-in owner or admin; nobody else', async () => {
    expect((await pull()).me).toBe('p_njeri');
    await pg.query(`select set_config('request.jwt.claim.sub', '', false)`);
    await expect(pull()).rejects.toThrow('not_admin');
    await signInAs(pg, 'p_wanjiku', '00000000-0000-4000-8000-000000000002');
    await expect(push([])).rejects.toThrow('not_admin');
  });

  it('the anon key cannot call the admin API at all', async () => {
    await pg.exec('set role anon');
    await expect(pull()).rejects.toThrow(/permission denied/);
    await expect(push([])).rejects.toThrow(/permission denied/);
    await pg.exec('reset role');
  });

  it('an archived admin is out', async () => {
    await pg.query(`update public.people set archived_at = now() where id = 'p_njeri'`);
    await expect(pull()).rejects.toThrow('not_admin');
  });
});

describe('approvals (R-VOID-2…4)', () => {
  it('approving a void voids the line and returns its stock; the decision is audited', async () => {
    await waitingVoid();
    const guinness = await stock('guinness');
    const r = await pushOne('approval_decided', { approval_id: 'a1', decision: 'approved', decided_at: now() });
    expect(r).toMatchObject({ status: 'applied' });
    expect((await one(`select status from public.lines where id = 'o_039_l0'`)).status).toBe('voided');
    expect(await stock('guinness')).toBe(guinness + 1);
    expect(await one(`select status, decided_by from public.approvals where id = 'a1'`)).toEqual({ status: 'approved', decided_by: 'p_njeri' });
    const audit = await one(`select actor_id, device_id, kind, ref_id, detail from public.audit_events where event_id = $1`, [r.id]);
    expect(audit).toMatchObject({ actor_id: 'p_njeri', device_id: 'admin', kind: 'approval_decided', ref_id: 'a1' });
  });

  it('a second decision is refused, whoever makes it, and changes nothing', async () => {
    await waitingVoid();
    await pushOne('approval_decided', { approval_id: 'a1', decision: 'rejected', decided_at: now() });
    const r = await pushOne('approval_decided', { approval_id: 'a1', decision: 'approved', decided_at: now() });
    expect(r).toMatchObject({ status: 'rejected', reason: 'already_decided' });
    expect((await one(`select status from public.lines where id = 'o_039_l0'`)).status).toBe('active');
  });

  it('undo inside two minutes reverses exactly; later it is refused', async () => {
    await waitingVoid();
    const guinness = await stock('guinness');
    await pushOne('approval_decided', { approval_id: 'a1', decision: 'approved', decided_at: now() });
    expect((await pushOne('approval_undone', { approval_id: 'a1' }, now(30_000))).status).toBe('applied');
    expect(await stock('guinness')).toBe(guinness);
    expect((await one(`select status from public.lines where id = 'o_039_l0'`)).status).toBe('void_pending');
    expect((await one(`select status from public.approvals where id = 'a1'`)).status).toBe('waiting');

    await pushOne('approval_decided', { approval_id: 'a1', decision: 'approved', decided_at: now() });
    expect(await pushOne('approval_undone', { approval_id: 'a1' }, now(3 * 60_000))).toMatchObject({ status: 'rejected', reason: 'too_late_to_undo' });
  });

  it('a comp of a tot takes 30 ml of Cane when approved (R-COMP-1)', async () => {
    await pg.query(
      `insert into public.approvals (id, kind, target, amount_kes, reason_code, requested_by, device_id, requested_at)
       values ('c1', 'comp', '{"order_id":null,"line_ids":[],"whole_order":false,"item":{"product_id":"cane","size_id":"cane_0","qty":1}}', 80, 'other', 'p_kiprop', 'd_counter2', now())`,
    );
    const cane = await stock('cane');
    await pushOne('approval_decided', { approval_id: 'c1', decision: 'approved', decided_at: now() });
    expect(await stock('cane')).toBe(cane - 30);
  });

  it('is idempotent by event id', async () => {
    await waitingVoid();
    const ev = adminEvent('approval_decided', { approval_id: 'a1', decision: 'approved', decided_at: now() });
    await push([ev]);
    const again = (await push([ev])).results[0]!;
    expect(again).toMatchObject({ status: 'applied', duplicate: true });
  });
});

describe('products, stock, kegs', () => {
  it('a price change is stored with its history, so later offline sales are checked against it (R-SELL-5)', async () => {
    const product = await one(`select * from public.products where id = 'tusker'`);
    const size = await one(`select * from public.sizes where id = 'tusker_0'`);
    const { updated_at: _p, ...p } = product;
    const { updated_at: _s, ...s } = size;
    await pushOne('product_saved', { product: p, sizes: [{ ...s, price_kes: 320 }], before: { product: p, sizes: [s] } });
    expect((await one(`select price_kes from public.sizes where id = 'tusker_0'`)).price_kes).toBe(320);
    expect((await one(`select count(*)::int as n from public.size_prices where size_id = 'tusker_0'`)).n).toBe(2);
  });

  it('a delivery adds stock and queues kegs (R-STOCK-2, R-STOCK-4)', async () => {
    await pushOne('delivery_recorded', {
      delivery: { id: 'dl1', supplier: 'Kamau', note_no: 'DN-1', received_by: 'p_njeri', created_at: now(), keg_ids: ['k10'],
        lines: [{ product_id: 'pilsner', container_label: 'Crate of 25', container_qty: 1, per_container: 25, total: 25 }] },
      kegs: [{ id: 'k10', product_id: 'keg', code: 'K-10', volume_ml: 50000, cup_ml: 500, status: 'queued', tapped_at: null, finished_at: null, finished_by: null, recorded_ml_baseline: 0 }],
    });
    expect(await stock('pilsner')).toBe(21);
    expect((await one(`select status from public.kegs where id = 'k10'`)).status).toBe('queued');
    expect((await one(`select reason, delta from public.stock_movements where ref_id = 'dl1'`))).toEqual({ reason: 'delivery', delta: 25 });
  });

  it('a shelf count sets the stock; keg finished puts the next on tap', async () => {
    await pushOne('shelf_counted', { product_id: 'pilsner', counted_qty: 3, before_qty: -4 });
    expect(await stock('pilsner')).toBe(3);
    await pushOne('keg_finished', { keg_id: 'k08', finished_at: now(), next_keg_id: 'k09' });
    expect((await one(`select status from public.kegs where id = 'k09'`)).status).toBe('active');
  });
});

describe('staff and devices', () => {
  it('an owner sets a PIN: admins can read the digits, counters get only the hash, the log keeps neither', async () => {
    const token = await pairAs(pg);
    const hash = 'pbkdf2-sha256$1$bmV3$bmV3';
    expect((await pushOne('pin_changed', { person_id: 'p_otieno', pin_hash: hash, pin_code: '4821' })).status).toBe('applied');
    expect(await one(`select pin_hash, pin_code from public.people where id = 'p_otieno'`)).toEqual({ pin_hash: hash, pin_code: '4821' });
    expect((await pull()).people.find((p: any) => p.id === 'p_otieno')).toMatchObject({ pin_code: '4821', pin_hash: hash });
    const counterPull = await call<Record<string, any>>(pg, 'select public.sync_pull($1, null) as r', [token]);
    const otieno = counterPull.people.find((p: any) => p.id === 'p_otieno');
    expect(otieno.pin_hash).toBe(hash);
    expect(otieno).not.toHaveProperty('pin_code');
    const log = await one(`select detail::text as detail from public.audit_events where kind = 'pin_changed'`);
    const stored = await one(`select payload::text as payload from public.events where type = 'pin_changed'`);
    for (const text of [log.detail, stored.payload]) {
      expect(text).toContain('p_otieno');
      expect(text).not.toMatch(/4821|bmV3/);
    }
  });

  it('PINs are 4 digits, for counter staff only', async () => {
    const hash = 'pbkdf2-sha256$1$bmV3$bmV3';
    expect((await pushOne('pin_changed', { person_id: 'p_otieno', pin_hash: hash, pin_code: '48210' })).reason).toMatch('4 digits');
    expect((await pushOne('pin_changed', { person_id: 'p_juma', pin_hash: hash, pin_code: '4821' })).reason).toMatch('PIN');
    expect((await pushOne('pin_changed', { person_id: 'p_chebet', pin_hash: hash, pin_code: '4821' })).reason).toMatch('only counter staff');
  });

  it('staff cannot set their own PIN at a counter', async () => {
    const token = await pairAs(pg);
    const pushed = await call<{ results: { status: string; reason: string }[] }>(pg, 'select public.sync_push($1, $2::jsonb) as r', [
      token,
      JSON.stringify([{ id: id('ev'), type: 'pin_set', payload: { person_id: 'p_otieno', pin_hash: 'pbkdf2-sha256$1$bmV3$bmV3' }, recorded_by: 'p_otieno', device_id: 'd_counter1', created_at: now() }]),
    ]);
    expect(pushed.results[0]!.status).not.toBe('applied');
    expect((await one(`select pin_hash from public.people where id = 'p_otieno'`)).pin_hash).not.toBe('pbkdf2-sha256$1$bmV3$bmV3');
  });

  it('suspending takes a person off the counters; reinstating gives access back; what their phone queued still lands', async () => {
    const token = await pairAs(pg);
    expect((await pushOne('person_suspended', { person_id: 'p_wanjiku' })).status).toBe('applied');
    const counterPull = await call<Record<string, any>>(pg, 'select public.sync_pull($1, null) as r', [token]);
    expect(counterPull.people.find((p: any) => p.id === 'p_wanjiku').suspended_at).not.toBeNull();
    // Recorded before the phone heard: still accepted.
    const pushed = await call<{ results: { status: string }[] }>(pg, 'select public.sync_push($1, $2::jsonb) as r', [
      token,
      JSON.stringify([{ id: id('ev'), type: 'logged_in', payload: { person_id: 'p_wanjiku' }, recorded_by: 'p_wanjiku', device_id: 'd_counter1', created_at: now(-60_000) }]),
    ]);
    expect(pushed.results[0]!.status).toBe('applied');
    expect((await pushOne('person_reinstated', { person_id: 'p_wanjiku' })).status).toBe('applied');
    expect((await one(`select suspended_at from public.people where id = 'p_wanjiku'`)).suspended_at).toBeNull();
    expect((await pushOne('person_suspended', { person_id: 'p_njeri' })).reason).toMatch('only counter staff');
  });

  it('R-DEV-2: a revoked phone gets nothing more, and what it sends is held for review', async () => {
    const token = await pairAs(pg);
    await pushOne('device_revoked', { device_id: 'd_counter1', reason: 'Phone lost' });
    expect(await call(pg, 'select public.sync_pull($1, null) as r', [token])).toEqual({ error: 'revoked_device' });
  });

  it('R-DEV-1: an admin makes a pairing code, and the phone it pairs records who paired it', async () => {
    const made = await call<{ code: string; expires_at: string }>(pg, `select public.admin_create_pairing_code('bar_baraka', 'Counter 3') as r`);
    expect(made.code).toMatch(/^\d{6}$/);
    const paired = await call<{ device_id: string }>(pg, 'select public.pair_device($1, null, $2) as r', [made.code, 'Tecno']);
    expect((await one('select paired_by from public.devices where id = $1', [paired.device_id])).paired_by).toBe('p_njeri');
  });

  it('nobody can archive themselves', async () => {
    expect(await pushOne('person_archived', { person_id: 'p_njeri' })).toMatchObject({ status: 'rejected', reason: 'cannot archive yourself' });
  });
});

describe('day close (R-DAY-3)', () => {
  it('is kept with its variance, once', async () => {
    const close = { business_day: '2026-11-10', till_total_kes: 47650, recorded_mpesa_kes: 48400, closed_by: 'p_njeri', closed_at: now() };
    expect((await pushOne('day_closed', { day_close: close })).status).toBe('applied');
    expect((await pushOne('day_closed', { day_close: close })).status).toBe('rejected');
  });
});

describe('admin_pull', () => {
  it('brings everything for the admin store, without tokens or auth ids, and audit rows with their detail', async () => {
    await waitingVoid();
    const r = await pushOne('approval_decided', { approval_id: 'a1', decision: 'approved', decided_at: now() });
    const data = await pull();
    expect(data.people.length).toBe(8);
    expect(JSON.stringify(data.devices)).not.toContain('token_hash');
    expect(JSON.stringify(data.people)).not.toContain('auth_user_id');
    expect(data.approvals.find((a: any) => a.id === 'a1').status).toBe('approved');
    const audit = data.auditEvents.find((a: any) => a.id === r.id);
    expect(audit).toMatchObject({ kind: 'approval_decided', detail: { approval_id: 'a1', decision: 'approved' } });
    // The cursor overlaps by 30 seconds, so only what changed just now comes again.
    const later = await pull(data.cursor);
    expect(later.products.map((p: any) => p.id)).toEqual(['guinness']);
  });
});
