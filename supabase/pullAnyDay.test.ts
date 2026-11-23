// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { call, freshDb, pairAs } from './testDb';

let pg: PGlite;
let one: string;
let two: string;

const push = async (token: string, device: string, type: string, payload: object) =>
  (await call<{ results: { status: string }[] }>(pg, 'select public.sync_push($1, $2::jsonb) as r', [
    token,
    JSON.stringify([{ id: `ev_${Math.random().toString(36).slice(2)}`, type, payload, recorded_by: 'p_wanjiku', device_id: device, created_at: new Date().toISOString() }]),
  ])).results[0]!;
const pull = (token: string, since: string | null) => call<Record<string, any>>(pg, 'select public.sync_pull($1, $2) as r', [token, since]);

beforeEach(async () => {
  pg = await freshDb();
  one = await pairAs(pg, 'd_counter1', 'Counter 1');
  two = await pairAs(pg, 'd_counter2', 'Counter 2');
});
afterEach(() => pg.close());

describe('changes on another counter reach this one, whatever day the order is from', () => {
  it('an older open order paid on Counter 1 comes down to Counter 2 as paid', async () => {
    // The seed's orders are from 10 Nov: long before "yesterday".
    const first = await pull(two, null);
    expect(first.orders.find((o: { id: string }) => o.id === 'o_039').status).toBe('open');

    const due = (await pg.query<{ due: number }>(`select sum(qty * unit_price_kes)::int as due from public.lines where order_id = 'o_039' and status <> 'voided'`)).rows[0]!.due;
    const paid = await push(one, 'd_counter1', 'payment_recorded', {
      order_id: 'o_039',
      payments: [{ id: 'pay_old', order_id: 'o_039', method: 'cash', amount_kes: due, mpesa_ref_last4: null, recorded_by: 'p_wanjiku', device_id: 'd_counter1', created_at: new Date().toISOString(), synced_at: null }],
    });
    expect(paid.status).toBe('applied');

    const next = await pull(two, first.cursor);
    expect(next.orders.find((o: { id: string }) => o.id === 'o_039')?.status).toBe('paid');
    expect(next.payments.map((p: { id: string }) => p.id)).toContain('pay_old');
  });

  it('a first pull still brings only open orders and today’s and yesterday’s', async () => {
    await pg.query(`update public.orders set status = 'paid' where id = 'o_039'`);
    const first = await pull(two, null);
    expect(first.orders.map((o: { id: string }) => o.id)).not.toContain('o_039');
  });
});
