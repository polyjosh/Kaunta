// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { call, freshDb, pairAs } from './testDb';

let pg: PGlite;
let token: string;

beforeEach(async () => {
  pg = await freshDb();
  token = await pairAs(pg);
});
afterEach(() => pg.close());

const DAY = '2026-11-10';
const HOUR = 3_600_000;
let n = 0;
const id = (prefix: string) => `${prefix}_${++n}_${Math.random().toString(36).slice(2, 8)}`;
/** Times relative to the database's real clock, since price history uses it. */
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

interface PushResult {
  id: string;
  status: 'applied' | 'needs_review';
  reason: string | null;
  detail: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  duplicate: boolean;
}

const push = (events: object[], tok = token) =>
  call<{ results: PushResult[]; error?: string }>(pg, 'select public.sync_push($1, $2::jsonb) as r', [tok, JSON.stringify(events)]);
const pull = (since: string | null = null, tok = token) =>
  call<Record<string, any>>(pg, 'select public.sync_pull($1, $2) as r', [tok, since]);
const one = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0]!;
const all = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;

const stamp = (createdAt: string, by = 'p_wanjiku') => ({ recorded_by: by, device_id: 'd_counter1', created_at: createdAt, synced_at: null });

function event(type: string, payload: object, createdAt = at(), by = 'p_wanjiku') {
  return { id: id('ev'), type, payload, recorded_by: by, device_id: 'd_counter1', created_at: createdAt };
}

function orderEvent(opts: { lines?: { size_id: string; product_id: string; qty: number; price: number }[]; createdAt?: string; paid?: number } = {}) {
  const createdAt = opts.createdAt ?? at();
  const orderId = id('o');
  const lines = (opts.lines ?? [{ size_id: 'tusker_0', product_id: 'tusker', qty: 2, price: 300 }]).map((l) => ({
    ...stamp(createdAt),
    id: id('l'),
    order_id: orderId,
    product_id: l.product_id,
    size_id: l.size_id,
    qty: l.qty,
    unit_price_kes: l.price,
    status: 'active',
    keg_id: null,
  }));
  const payments = opts.paid
    ? [{ ...stamp(createdAt), id: id('p'), order_id: orderId, method: 'cash', amount_kes: opts.paid, mpesa_ref_last4: null }]
    : [];
  const order = {
    ...stamp(createdAt),
    id: orderId,
    short_no: '#049',
    short_no_provisional: true,
    label: 'Table 4',
    server_id: 'p_wanjiku',
    business_day: DAY,
    status: opts.paid ? 'paid' : 'open',
    handed_over_to: null,
  };
  return { ev: event('order_recorded', { order, lines, payments }, createdAt), order, lines };
}

const stockOf = async (product: string) =>
  (await one<{ stock_qty: number | null }>('select stock_qty from public.products where id = $1', [product])).stock_qty;

describe('pairing (R-DEV-1)', () => {
  it('a code pairs once, and only a hash of the token is stored', async () => {
    const code = await call<string>(pg, "select public.create_pairing_code('Counter 2', 'd_counter2', 'p_njeri') as r");
    expect(code).toMatch(/^\d{6}$/);
    const paired = await call<{ device_id: string; token: string }>(pg, 'select public.pair_device($1) as r', [code]);
    expect(paired.device_id).toBe('d_counter2');
    expect(paired.token).toMatch(/^[0-9a-f]{64}$/);
    const device = await one<{ token_hash: string; paired_by: string }>("select token_hash, paired_by from public.devices where id = 'd_counter2'");
    expect(device.token_hash).not.toBe(paired.token);
    expect(device.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(device.paired_by).toBe('p_njeri');

    expect(await call(pg, 'select public.pair_device($1) as r', [code])).toEqual({ error: 'invalid_code' });
  });

  it('refuses unknown and expired codes', async () => {
    expect(await call(pg, "select public.pair_device('000000') as r")).toEqual({ error: 'invalid_code' });
    const code = await call<string>(pg, "select public.create_pairing_code('Counter 3') as r");
    await pg.query("update public.pairing_codes set expires_at = now() - interval '1 second' where code = $1", [code]);
    expect(await call(pg, 'select public.pair_device($1) as r', [code])).toEqual({ error: 'invalid_code' });
  });

  it('a new device gets its own row', async () => {
    const code = await call<string>(pg, "select public.create_pairing_code('Bar phone') as r");
    const paired = await call<{ device_id: string }>(pg, "select public.pair_device($1, null, 'Tecno') as r", [code]);
    expect(await one('select name, model from public.devices where id = $1', [paired.device_id])).toEqual({ name: 'Bar phone', model: 'Tecno' });
  });

  it('stops all pairing for 10 minutes after 20 wrong codes, so codes cannot be guessed', async () => {
    const code = await call<string>(pg, "select public.create_pairing_code('Counter 2') as r");
    for (let i = 0; i < 20; i++) await call(pg, "select public.pair_device('999999') as r");
    expect(await call(pg, 'select public.pair_device($1) as r', [code])).toEqual({ error: 'too_many_attempts' });
  });
});

describe('sync_push', () => {
  it('rejects a token it does not know', async () => {
    expect(await push([], 'not-a-token')).toEqual({ error: 'unknown_device' });
  });

  it('applies a sale: final order number, stock, server stamps, event and audit rows', async () => {
    const { ev, order } = orderEvent();
    const { results } = await push([ev]);
    expect(results).toEqual([
      { id: ev.id, status: 'applied', reason: null, detail: null, result: { order_id: order.id, short_no: '#049' }, duplicate: false },
    ]);
    expect(await one('select short_no, short_no_provisional, status, synced_at is not null as synced from public.orders where id = $1', [order.id]))
      .toEqual({ short_no: '#049', short_no_provisional: false, status: 'open', synced: true });
    expect(await stockOf('tusker')).toBe(22);
    expect(await one('select status from public.events where id = $1', [ev.id])).toEqual({ status: 'applied' });
    expect(await one('select kind, actor_id, ref_id from public.audit_events where event_id = $1', [ev.id]))
      .toEqual({ kind: 'order_recorded', actor_id: 'p_wanjiku', ref_id: order.id });
    expect(await one("select last_sync_at is not null as synced from public.devices where id = 'd_counter1'")).toEqual({ synced: true });
  });

  it('R-DAY-2 numbers orders per business day in arrival order, whatever the phone guessed', async () => {
    const a = orderEvent();
    const b = orderEvent(); // both phones guessed #049
    const { results } = await push([a.ev, b.ev]);
    expect(results.map((r) => r.result?.short_no)).toEqual(['#049', '#050']);
  });

  it('is idempotent: sending the same event twice applies it once', async () => {
    const { ev } = orderEvent();
    await push([ev]);
    const again = await push([ev]);
    expect(again.results[0]).toMatchObject({ status: 'applied', duplicate: true, result: { short_no: '#049' } });
    expect(await stockOf('tusker')).toBe(22);
    expect(await one<{ n: number }>('select count(*)::int as n from public.events where id = $1', [ev.id])).toEqual({ n: 1 });
  });

  it('R-SELL-5 an offline sale at an old price is kept as recorded and raises a price mismatch', async () => {
    await pg.query("update public.sizes set price_kes = 320 where id = 'tusker_0'");
    const { ev, order, lines } = orderEvent({ createdAt: at(HOUR) }); // after the change, still at 300
    const { results } = await push([ev]);

    expect(results[0]).toMatchObject({
      status: 'needs_review',
      reason: 'price_mismatch',
      detail: { product_name: 'Tusker Lager', recorded_price_kes: 300, server_price_kes: 320, qty: 2 },
      result: { short_no: '#049' },
    });
    expect(await one('select unit_price_kes from public.lines where id = $1', [lines[0]!.id])).toEqual({ unit_price_kes: 300 });
    expect(await one('select kind, amount_kes, status, requested_by, target from public.approvals where kind = $1', ['price_mismatch']))
      .toEqual({
        kind: 'price_mismatch',
        amount_kes: 40, // (320 − 300) × 2
        status: 'waiting',
        requested_by: 'system',
        target: { order_id: order.id, line_ids: [lines[0]!.id], whole_order: false },
      });
  });

  it('a sale made before the price changed is not a mismatch', async () => {
    const { ev } = orderEvent({ createdAt: at(-HOUR) });
    await pg.query("update public.sizes set price_kes = 320 where id = 'tusker_0'");
    expect((await push([ev])).results[0]!.status).toBe('applied');
  });

  it('a sale of a product archived before it was made is kept and flagged', async () => {
    await pg.query("update public.products set archived_at = now() - interval '1 hour' where id = 'tusker'");
    const { ev } = orderEvent();
    expect((await push([ev])).results[0]).toMatchObject({ status: 'needs_review', reason: 'archived_product' });
    expect(await one('select amount_kes from public.approvals where kind = $1', ['archived_product'])).toEqual({ amount_kes: 600 });
  });

  it('payments update the order status (R-ORD-2)', async () => {
    const pay = (amount: number) =>
      event('payment_recorded', {
        order_id: 'o_048',
        payments: [{ ...stamp(at()), id: id('p'), order_id: 'o_048', method: 'mpesa', amount_kes: amount, mpesa_ref_last4: 'QK7P' }],
      });
    await push([pay(200)]);
    expect(await one("select status from public.orders where id = 'o_048'")).toEqual({ status: 'open' });
    await push([pay(400)]);
    expect(await one("select status from public.orders where id = 'o_048'")).toEqual({ status: 'paid' });
  });

  it('an event that cannot be applied is kept for review, and the next one still goes in', async () => {
    const orphan = event('payment_recorded', {
      order_id: 'nope',
      payments: [{ ...stamp(at()), id: id('p'), order_id: 'nope', method: 'cash', amount_kes: 100, mpesa_ref_last4: null }],
    });
    const { ev: next } = orderEvent();
    const { results } = await push([orphan, next]);
    expect(results[0]).toMatchObject({ status: 'needs_review', reason: 'not_applied' });
    expect(String(results[0]!.detail?.message)).toMatch(/unknown order/);
    expect(results[1]!.status).toBe('applied');
    expect(await one('select status, payload is not null as kept from public.events where id = $1', [orphan.id]))
      .toEqual({ status: 'needs_review', kept: true });
    expect(await one<{ n: number }>("select count(*)::int as n from public.payments where order_id = 'nope'")).toEqual({ n: 0 });
  });

  it('voids: self-void returns stock, a request waits as void_pending with an approval', async () => {
    const { ev, order, lines } = orderEvent();
    const splitId = id('l');
    await push([ev]);
    await push([
      event('void_recorded', {
        order_id: order.id,
        parts: [{ line_id: lines[0]!.id, qty: 1, split_line_id: splitId }],
        reason: 'mistake',
        voided_at: at(),
      }),
    ]);
    expect(await all('select qty, status from public.lines where order_id = $1 order by status', [order.id]))
      .toEqual([{ qty: 1, status: 'active' }, { qty: 1, status: 'voided' }]);
    expect(await stockOf('tusker')).toBe(23);

    const approvalId = id('a');
    await push([
      event('void_requested', {
        order_id: order.id,
        parts: [{ line_id: lines[0]!.id, qty: 1, split_line_id: null }],
        approval: {
          id: approvalId, kind: 'void', target: { order_id: order.id, line_ids: [lines[0]!.id], whole_order: false },
          amount_kes: 300, reason_code: 'other', requested_by: 'p_wanjiku', device_id: 'd_counter1',
          requested_at: at(), status: 'waiting', decided_by: null, decided_at: null,
        },
      }),
    ]);
    expect(await one('select status from public.lines where id = $1', [lines[0]!.id])).toEqual({ status: 'void_pending' });
    expect(await one('select kind, status from public.approvals where id = $1', [approvalId])).toEqual({ kind: 'void', status: 'waiting' });
    expect(await stockOf('tusker')).toBe(23); // not returned until approved
    expect(await one('select status from public.orders where id = $1', [order.id])).toEqual({ status: 'open' });
  });

  it('split by items: the new order gets a server number and the lines move', async () => {
    const tusker = await one<{ id: string }>("select id from public.lines where order_id = 'o_047' and size_id = 'tusker_0'");
    const newId = id('o');
    const splitId = id('l');
    const { results } = await push([
      event('lines_moved', {
        from_order_id: 'o_047',
        order: { ...stamp(at()), id: newId, short_no: '#049', short_no_provisional: true, label: 'Table 4', server_id: 'p_wanjiku', business_day: DAY, status: 'open', handed_over_to: null },
        parts: [{ line_id: tusker.id, qty: 1, split_line_id: splitId }],
      }),
    ]);
    expect(results[0]!.result).toEqual({ order_id: newId, short_no: '#049' });
    expect(await one('select order_id, qty from public.lines where id = $1', [splitId])).toEqual({ order_id: newId, qty: 1 });
    expect(await one('select qty from public.lines where id = $1', [tusker.id])).toEqual({ qty: 1 });
  });

  it('items added to an order take stock and are price-checked too', async () => {
    await pg.query("update public.sizes set price_kes = 350 where id = 'guinness_0'");
    const line = { ...stamp(at(HOUR)), id: id('l'), order_id: 'o_044', product_id: 'guinness', size_id: 'guinness_0', qty: 1, unit_price_kes: 330, status: 'active', keg_id: null };
    const { results } = await push([event('lines_added', { order_id: 'o_044', lines: [line] }, at(HOUR))]);
    expect(results[0]).toMatchObject({ status: 'needs_review', reason: 'price_mismatch' });
    expect(await stockOf('guinness')).toBe(17);
  });

  it('PIN locks reach the server for every device (R-PIN-1), and a login clears them', async () => {
    const until = at(5 * 60_000);
    await push([event('pin_failed', { person_id: 'p_kiprop', failed_pin_attempts: 5, pin_locked_until: until })]);
    const locked = await one<{ failed_pin_attempts: number; locked: boolean }>(
      "select failed_pin_attempts, pin_locked_until is not null as locked from public.people where id = 'p_kiprop'",
    );
    expect(locked).toEqual({ failed_pin_attempts: 5, locked: true });
    await push([event('logged_in', { person_id: 'p_kiprop' })]);
    expect(await one("select failed_pin_attempts, pin_locked_until from public.people where id = 'p_kiprop'"))
      .toEqual({ failed_pin_attempts: 0, pin_locked_until: null });
  });

  it('shifts open and close; handed-over orders move to the next person', async () => {
    const shiftId = id('s');
    await push([
      event('shift_opened', {
        shift: { id: shiftId, person_id: 'p_kiprop', device_id: 'd_counter1', opened_at: at(), float_kes: 0, expenses: [], closed_at: null, counted_cash_kes: null, result_kes: null, cash_baseline_kes: 0, mpesa_baseline_kes: 0 },
      }),
      event('shift_closed', { shift_id: shiftId, closed_at: at(), counted_cash_kes: 500, expected_cash_kes: 600, result_kes: -100 }),
      event('order_handed_over', { order_id: 'o_047', from: 'p_wanjiku' }),
    ]);
    expect(await one('select counted_cash_kes, result_kes from public.shifts where id = $1', [shiftId])).toEqual({ counted_cash_kes: 500, result_kes: -100 });
    expect(await one("select handover_pending from public.orders where id = 'o_047'")).toEqual({ handover_pending: true });
    await push([event('handover_accepted', { order_ids: ['o_047'], person_id: 'p_kiprop' })]);
    expect(await one("select handed_over_to, handover_pending from public.orders where id = 'o_047'"))
      .toEqual({ handed_over_to: 'p_kiprop', handover_pending: false });
  });
});

describe('revoked and mismatched devices (R-DEV-2, R-SYNC-3)', () => {
  it('a revoked phone’s events are quarantined: kept, not applied, and an admin is asked', async () => {
    await pg.query("update public.devices set revoked_at = now(), revoked_reason = 'Phone lost' where id = 'd_counter1'");
    const { ev, order } = orderEvent();
    const { results } = await push([ev]);
    expect(results[0]).toMatchObject({ status: 'needs_review', reason: 'revoked_device' });
    expect(await all('select id from public.orders where id = $1', [order.id])).toEqual([]);
    expect(await one('select status from public.events where id = $1', [ev.id])).toEqual({ status: 'needs_review' });
    expect(await one("select kind, amount_kes from public.approvals where kind = 'revoked_device'")).toEqual({ kind: 'revoked_device', amount_kes: 600 });
    expect(await pull()).toEqual({ error: 'revoked_device' });
  });

  it('an event claiming another device is quarantined', async () => {
    const { ev } = orderEvent();
    const { results } = await push([{ ...ev, device_id: 'd_counter2' }]);
    expect(results[0]).toMatchObject({ status: 'needs_review', reason: 'wrong_device' });
  });
});

describe('sync_pull', () => {
  it('a first pull brings everything a counter needs, without device tokens', async () => {
    const data = await pull();
    expect(data.bar).toHaveLength(1);
    expect(data.categories).toHaveLength(5);
    expect(data.people).toHaveLength(8);
    expect(data.products).toHaveLength(24);
    expect(data.sizes).toHaveLength(40);
    expect(data.kegs).toHaveLength(3);
    expect(data.orders).toHaveLength(5);
    expect(data.lines).toHaveLength(16);
    expect(data.shifts.length).toBeGreaterThan(0);
    expect(JSON.stringify(data.devices)).not.toContain('token_hash');
    expect(data.people.find((p: any) => p.id === 'p_wanjiku').pin_hash).toMatch(/^pbkdf2-sha256\$/);
    expect(data.products[0]).not.toHaveProperty('updated_at');
  });

  it('later pulls bring only what changed', async () => {
    const first = await pull();
    await new Promise((r) => setTimeout(r, 5));
    const { ev, order } = orderEvent();
    await push([ev]);
    // Start from just before the push, not the overlapping cursor, to see exactly what changed.
    const since = new Date(Date.now() - 2000).toISOString();
    const later = await pull(since);
    expect(later.orders.map((o: any) => o.id)).toEqual([order.id]);
    expect(later.lines).toHaveLength(1);
    expect(later.products.map((p: any) => p.id)).toEqual(['tusker']); // stock changed
    expect(later.sizes).toEqual([]);
    expect(Date.parse(first.cursor)).toBeLessThan(Date.parse(first.server_time));
  });

  it('rejects an unknown token', async () => {
    expect(await pull(null, 'nope')).toEqual({ error: 'unknown_device' });
  });
});

describe('access', () => {
  it('the public (anon) key cannot read tables or make pairing codes, only call the sync API', async () => {
    await pg.query('set role anon');
    await expect(pg.query('select * from public.orders')).rejects.toThrow(/permission denied/);
    await expect(pg.query('select * from public.people')).rejects.toThrow(/permission denied/);
    await expect(pg.query("select public.create_pairing_code('x')")).rejects.toThrow(/permission denied/);
    await expect(pg.query('select public.apply_event($1, $2)', ['d_counter1', '{}'])).rejects.toThrow(/permission denied/);
    const ok = await pg.query<{ r: { error: string } }>("select public.sync_push('nope', '[]') as r");
    expect(ok.rows[0]!.r).toEqual({ error: 'unknown_device' });
    await pg.query('reset role');
  });

  it('the audit log cannot be changed or deleted', async () => {
    await push([orderEvent().ev]);
    await expect(pg.query("update public.audit_events set kind = 'x'")).rejects.toThrow(/append-only/);
    await expect(pg.query('delete from public.audit_events')).rejects.toThrow(/append-only/);
  });
});
