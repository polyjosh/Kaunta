// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { call, freshDb, pairAs } from './testDb';

let pg: PGlite;
let token: string;
let n = 0;
const id = (prefix: string) => `${prefix}_${++n}_${Math.random().toString(36).slice(2, 8)}`;
const one = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0]!;
const counter = (type: string, payload: object) => ({ id: id('ev'), type, payload, recorded_by: 'p_kiprop', device_id: 'd_counter1', created_at: new Date().toISOString() });
const push = async (events: object[]) =>
  (await call<{ results: { status: string; reason: string | null }[] }>(pg, 'select public.sync_push($1, $2::jsonb) as r', [token, JSON.stringify(events)])).results;

beforeEach(async () => {
  pg = await freshDb();
  token = await pairAs(pg);
});
afterEach(() => pg.close());

describe('nickname on an open order', () => {
  it('is saved (trimmed), pulled by phones, and cleared with an empty one', async () => {
    expect((await push([counter('order_noted', { order_id: 'o_039', note: '  Mzee in blue ' })]))[0]!.status).toBe('applied');
    expect((await one(`select note from public.orders where id = 'o_039'`)).note).toBe('Mzee in blue');
    const pulled = await call<Record<string, any>>(pg, 'select public.sync_pull($1, $2) as r', [token, null]);
    expect(pulled.orders.find((o: { id: string }) => o.id === 'o_039').note).toBe('Mzee in blue');
    await push([counter('order_noted', { order_id: 'o_039', note: '' })]);
    expect((await one(`select note from public.orders where id = 'o_039'`)).note).toBeNull();
  });

  it('is refused on an order that is not open', async () => {
    await pg.query(`update public.orders set status = 'paid' where id = 'o_039'`);
    expect((await push([counter('order_noted', { order_id: 'o_039', note: 'x' })]))[0]!.status).toBe('needs_review');
  });
});

describe('handing an order over to someone', () => {
  it('makes it theirs at once', async () => {
    expect((await push([counter('order_handed_over', { order_id: 'o_039', from: 'p_kiprop', to: 'p_otieno' })]))[0]!.status).toBe('applied');
    expect(await one(`select handed_over_to, handover_pending from public.orders where id = 'o_039'`)).toEqual({ handed_over_to: 'p_otieno', handover_pending: false });
    expect((await one(`select kind, ref_id from public.audit_events where kind = 'order_handed_over' order by at desc limit 1`)).ref_id).toBe('o_039');
  });

  it('refuses an unknown person or the person handing over', async () => {
    expect((await push([counter('order_handed_over', { order_id: 'o_039', from: 'p_kiprop', to: 'p_nobody' })]))[0]!.status).toBe('needs_review');
    expect((await push([counter('order_handed_over', { order_id: 'o_039', from: 'p_kiprop', to: 'p_kiprop' })]))[0]!.status).toBe('needs_review');
  });

  it('without "to" (older phones) still waits for the next person on the phone', async () => {
    await push([counter('order_handed_over', { order_id: 'o_039', from: 'p_kiprop' })]);
    expect(await one(`select handed_over_to, handover_pending from public.orders where id = 'o_039'`)).toEqual({ handed_over_to: null, handover_pending: true });
  });
});
