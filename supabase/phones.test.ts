// @vitest-environment node
// Real phones' local stores (IndexedDB via fake-indexeddb) syncing with the
// real migration (PGlite): the whole loop, end to end, without a network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { recordOrder, recordPayment } from '../src/data/commands';
import { KauntaDB } from '../src/data/db';
import { attemptLogin } from '../src/data/login';
import { outboxCounts } from '../src/data/outbox';
import type { RecordContext } from '../src/data/outbox';
import { orderDue } from '../src/domain/orders';
import { syncPillStatus } from '../src/lib/sync';
import { resetForPairing } from '../src/sync/apply';
import { SyncEngine } from '../src/sync/engine';
import type { PairResponse, PullResponse, PushResponse, SyncTransport, WireEvent } from '../src/sync/transport';
import { call, freshDb } from './testDb';
import { readFileSync } from 'node:fs';

const demo = (JSON.parse(readFileSync(new URL('../kaunta-handoff/data/seed.json', import.meta.url), 'utf8')) as {
  people: { id: string; demo_pin?: string }[];
}).people.find((p) => p.demo_pin)!;

/** The transport, but calling the SQL functions directly instead of over HTTP. */
class PgTransport implements SyncTransport {
  constructor(private readonly pg: PGlite) {}
  push(token: string, events: WireEvent[]) {
    return call<PushResponse>(this.pg, 'select public.sync_push($1, $2::jsonb) as r', [token, JSON.stringify(events)]);
  }
  pull(token: string, since: string | null) {
    return call<PullResponse>(this.pg, 'select public.sync_pull($1, $2) as r', [token, since]);
  }
  pair(code: string, name: string | null = null, model: string | null = null) {
    return call<PairResponse>(this.pg, 'select public.pair_device($1, $2, $3) as r', [code, name, model]);
  }
}

let pg: PGlite;
let n = 0;
const phones: KauntaDB[] = [];

beforeEach(async () => {
  pg = await freshDb();
});
afterEach(async () => {
  await Promise.all(phones.splice(0).map((db) => db.delete()));
  await pg.close();
});

/** What the Pair screen does: trade a code for a token, clear the phone, pull everything. */
async function pairPhone(deviceId: string, name: string) {
  const db = new KauntaDB(`kaunta-phone-${++n}`);
  phones.push(db);
  const transport = new PgTransport(pg);
  const code = await call<string>(pg, 'select public.create_pairing_code($1, $2) as r', [name, deviceId]);
  const paired = await transport.pair(code, name, 'test phone');
  if ('error' in paired) throw new Error(paired.error);
  await resetForPairing(db, paired.device_id, paired.token);
  const engine = new SyncEngine(db, transport, { setTimer: () => null, clearTimer: () => {} });
  await engine.runOnce();
  const ctx = (person = 'p_wanjiku'): RecordContext => ({ person_id: person, device_id: deviceId });
  return { db, engine, ctx };
}

const serverOrder = (id: string) => pg.query<{ short_no: string; status: string }>('select short_no, status from public.orders where id = $1', [id]).then((r) => r.rows[0]);

describe('a paired phone', () => {
  it('gets the menu, staff and open orders from the server, and PINs work offline against the synced hash', async () => {
    const { db } = await pairPhone('d_counter1', 'Counter 1');
    expect(await db.products.count()).toBe(24);
    expect(await db.orders.where('status').equals('open').count()).toBe(5);
    expect((await db.meta.get('device_id'))?.value).toBe('d_counter1');
    expect((await db.devices.get('d_counter1'))?.name).toBe('Counter 1');
    expect(await attemptLogin(db, 'd_counter1', demo.id, demo.demo_pin!)).toEqual({ status: 'ok' });
  });

  it('sells, syncs, and ends up with the server’s order number and stamps', async () => {
    const { db, engine, ctx } = await pairPhone('d_counter1', 'Counter 1');
    const order = await recordOrder(db, ctx(), { label: 'Table 4', server_id: 'p_wanjiku', items: [{ size_id: 'tusker_0', qty: 2 }] });
    expect(order.synced_at).toBeNull();
    await engine.runOnce();

    expect(await serverOrder(order.id)).toEqual({ short_no: '#049', status: 'open' });
    const local = (await db.orders.get(order.id))!;
    expect(local).toMatchObject({ short_no: '#049', short_no_provisional: false });
    expect(local.synced_at).not.toBeNull();
    expect((await db.products.get('tusker'))?.stock_qty).toBe(22); // the server's count, pulled back
    expect(await outboxCounts(db)).toEqual({ queued: 0, needsAdmin: 0 });
  });

  it('two counters see each other’s sales and payments', async () => {
    const one = await pairPhone('d_counter1', 'Counter 1');
    const two = await pairPhone('d_counter2', 'Counter 2');

    const order = await recordOrder(one.db, one.ctx(), { label: 'Table 7', server_id: 'p_wanjiku', items: [{ size_id: 'guinness_0', qty: 1 }] });
    await one.engine.runOnce();
    await two.engine.runOnce();
    expect((await two.db.orders.get(order.id))?.label).toBe('Table 7');

    await recordPayment(two.db, two.ctx('p_akinyi'), order.id, [{ method: 'mpesa', amount_kes: 330, mpesa_ref_last4: 'QK7P' }]);
    await two.engine.runOnce();
    await one.engine.runOnce();
    const payments = await one.db.payments.where('order_id').equals(order.id).toArray();
    expect(payments).toMatchObject([{ amount_kes: 330, recorded_by: 'p_akinyi', device_id: 'd_counter2' }]);
    expect((await one.db.orders.get(order.id))?.status).toBe('paid');
    expect(orderDue(await one.db.lines.where('order_id').equals(order.id).toArray(), payments)).toBe(0);
  });

  it('two offline counters that guessed the same number get different final numbers', async () => {
    const one = await pairPhone('d_counter1', 'Counter 1');
    const two = await pairPhone('d_counter2', 'Counter 2');
    const a = await recordOrder(one.db, one.ctx(), { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'soda_0', qty: 1 }] });
    const b = await recordOrder(two.db, two.ctx('p_akinyi'), { label: 'Counter', server_id: 'p_akinyi', items: [{ size_id: 'soda_0', qty: 1 }] });
    expect(a.short_no).toBe(b.short_no); // both guessed #049
    await one.engine.runOnce();
    await two.engine.runOnce();
    expect([(await serverOrder(a.id))!.short_no, (await serverOrder(b.id))!.short_no]).toEqual(['#049', '#050']);
    expect((await two.db.orders.get(b.id))?.short_no).toBe('#050');
  });

  it('a sale at a price changed on the server while the phone was offline: kept, and the pill says an admin is needed', async () => {
    const { db, engine, ctx } = await pairPhone('d_counter1', 'Counter 1');
    await pg.query("update public.sizes set price_kes = 320 where id = 'tusker_0'"); // the phone has not heard
    const order = await recordOrder(db, ctx(), { label: 'Table 6', server_id: 'p_wanjiku', items: [{ size_id: 'tusker_0', qty: 1 }] });
    await engine.runOnce();

    const flagged = (await db.outbox.toArray()).find((e) => e.type === 'order_recorded')!;
    expect(flagged).toMatchObject({
      status: 'needs_review',
      review_reason: 'price_mismatch',
      review_detail: { recorded_price_kes: 300, server_price_kes: 320 },
    });
    expect(syncPillStatus({ online: true, sending: 0, ...(await outboxCounts(db)) })).toEqual({ state: 'needsAdmin', count: 1 });
    // Kept as recorded, on the server and on the phone.
    const line = (await db.lines.where('order_id').equals(order.id).toArray())[0]!;
    expect(line.unit_price_kes).toBe(300);
    // And the new price reaches the phone for the next sale.
    expect((await db.sizes.get('tusker_0'))?.price_kes).toBe(320);
  });

  it('a PIN lock on one counter reaches the other (R-PIN-1)', async () => {
    const one = await pairPhone('d_counter1', 'Counter 1');
    const two = await pairPhone('d_counter2', 'Counter 2');
    for (let i = 0; i < 5; i++) await attemptLogin(one.db, 'd_counter1', demo.id, '0000' === demo.demo_pin ? '1111' : '0000');
    await one.engine.runOnce();
    await two.engine.runOnce();
    expect(await attemptLogin(two.db, 'd_counter2', demo.id, demo.demo_pin!)).toMatchObject({ status: 'locked' });
  });
});
