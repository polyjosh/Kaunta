import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderDue } from '../domain/orders';
import { syncPillStatus } from '../lib/sync';
import { recordOrder, recordPayment } from './commands';
import { KauntaDB } from './db';
import { markNeedsReview, markSent, noteAttempt, outboxCounts, pendingEvents } from './outbox';
import type { RecordContext } from './outbox';
import { seedDatabase } from './seedDb';

let db: KauntaDB;
let n = 0;

// 22:43 EAT on business day 10 Nov, on Counter 1, Wanjiku recording.
const at = (iso: string): RecordContext => ({ person_id: 'p_wanjiku', device_id: 'd_counter1', now: () => new Date(iso) });
const ctx = at('2026-11-10T19:43:00.000Z');

beforeEach(async () => {
  db = new KauntaDB(`kaunta-test-${++n}`);
  await seedDatabase(db);
});

afterEach(async () => {
  await db.delete();
});

describe('seedDatabase', () => {
  it('loads the sample data with an empty outbox', async () => {
    expect(await db.products.count()).toBe(24);
    expect(await db.sizes.count()).toBe(40);
    expect(await db.lines.count()).toBe(16);
    expect(await db.people.count()).toBe(8);
    expect(await db.orders.where('status').equals('open').count()).toBe(5);
    expect(await db.outbox.count()).toBe(0);
  });

  it('never overwrites a store that is already seeded', async () => {
    await recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'tusker_0', qty: 1 }] });
    expect(await seedDatabase(db)).toBe(false);
    expect(await db.orders.count()).toBe(6);
  });
});

describe('recordOrder (R-SELL-4, R-SELL-5, R-SYNC-1)', () => {
  it('pay later: creates an open order, on screen at once and queued to sync', async () => {
    const order = await recordOrder(db, ctx, {
      label: 'Table 4',
      server_id: 'p_kiprop',
      items: [
        { size_id: 'tusker_0', qty: 2 },
        { size_id: 'cane_0', qty: 1 },
      ],
    });

    expect(order).toMatchObject({
      status: 'open',
      label: 'Table 4',
      server_id: 'p_kiprop',
      recorded_by: 'p_wanjiku',
      device_id: 'd_counter1',
      business_day: '2026-11-10',
      created_at: '2026-11-10T19:43:00.000Z',
      synced_at: null,
    });
    const lines = await db.lines.where('order_id').equals(order.id).toArray();
    expect(lines.map((l) => [l.size_id, l.qty, l.unit_price_kes])).toEqual(
      expect.arrayContaining([
        ['tusker_0', 2, 300],
        ['cane_0', 1, 80],
      ]),
    );
    expect(orderDue(lines, [])).toBe(680);
    for (const line of lines) expect(line).toMatchObject({ recorded_by: 'p_wanjiku', device_id: 'd_counter1', synced_at: null });

    const pending = await pendingEvents(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ type: 'order_recorded', status: 'pending', recorded_by: 'p_wanjiku', attempts: 0 });
  });

  it('record & paid: creates the order and a payment for the full total', async () => {
    const order = await recordOrder(db, ctx, {
      label: 'Counter',
      server_id: 'p_wanjiku',
      items: [{ size_id: 'guinness_0', qty: 2 }],
      paid_by: 'mpesa',
    });
    expect(order.status).toBe('paid');
    const payments = await db.payments.where('order_id').equals(order.id).toArray();
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ method: 'mpesa', amount_kes: 660, mpesa_ref_last4: null, recorded_by: 'p_wanjiku' });
  });

  it('copies the price on the phone at the time of sale; a later price change does not touch it', async () => {
    const order = await recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'tusker_0', qty: 1 }] });
    await db.sizes.update('tusker_0', { price_kes: 320 });
    const [line] = await db.lines.where('order_id').equals(order.id).toArray();
    expect(line?.unit_price_kes).toBe(300);
  });

  it('R-DAY-2 numbers orders from the highest used that business day, as provisional', async () => {
    const first = await recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'soda_0', qty: 1 }] });
    const second = await recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'soda_0', qty: 1 }] });
    expect([first.short_no, second.short_no]).toEqual(['#049', '#050']);
    expect(first.short_no_provisional).toBe(true);
  });

  it('R-DAY-1/2 a sale at 02:14 stays on the same business day; at 06:00 numbers restart', async () => {
    const lateNight = await recordOrder(db, at('2026-11-10T23:14:00.000Z'), {
      label: 'Counter',
      server_id: 'p_wanjiku',
      items: [{ size_id: 'soda_0', qty: 1 }],
    });
    expect(lateNight).toMatchObject({ business_day: '2026-11-10', short_no: '#049' });

    const nextDay = await recordOrder(db, at('2026-11-11T03:00:00.000Z'), {
      label: 'Counter',
      server_id: 'p_wanjiku',
      items: [{ size_id: 'soda_0', qty: 1 }],
    });
    expect(nextDay).toMatchObject({ business_day: '2026-11-11', short_no: '#001' });
  });

  it('R-SELL-2 refuses a product switched to out of stock', async () => {
    await expect(
      recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'cider_0', qty: 1 }] }),
    ).rejects.toThrow(/out of stock/);
    expect(await db.outbox.count()).toBe(0);
  });

  it('rejects empty orders and bad quantities without saving anything', async () => {
    await expect(recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [] })).rejects.toThrow(RangeError);
    for (const qty of [0, -1, 1.5]) {
      await expect(
        recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'tusker_0', qty }] }),
      ).rejects.toThrow(RangeError);
    }
    expect(await db.orders.count()).toBe(5);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe('stock on sale (R-STOCK-1, R-SELL-2, R-STOCK-3)', () => {
  const stock = async (id: string) => (await db.products.get(id))!.stock_qty;

  it('count mode takes units; ml mode takes millilitres from one pool', async () => {
    const order = await recordOrder(db, ctx, {
      label: 'Table 1',
      server_id: 'p_wanjiku',
      items: [
        { size_id: 'tusker_0', qty: 3 }, // 24 → 21 bottles
        { size_id: 'cane_0', qty: 2 }, // 2 tots = 60 ml
        { size_id: 'cane_1', qty: 1 }, // 250 ml
      ],
    });
    expect(await stock('tusker')).toBe(21);
    expect(await stock('cane')).toBe(4850 - 60 - 250);

    const lines = await db.lines.where('order_id').equals(order.id).toArray();
    const movements = await db.stockMovements.where('ref_id').anyOf(lines.map((l) => l.id)).toArray();
    expect(movements.map((m) => m.delta).sort((a, b) => a - b)).toEqual([-250, -60, -3]);
    for (const m of movements) expect(m).toMatchObject({ reason: 'sale', recorded_by: 'p_wanjiku' });
  });

  it('selling at or below zero is allowed and goes negative', async () => {
    await recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'pilsner_0', qty: 2 }] });
    expect(await stock('pilsner')).toBe(-6);
  });

  it('untracked products (food) record no stock movement', async () => {
    await recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'nyama_1', qty: 1 }] });
    expect(await stock('nyama')).toBeNull();
    expect(await db.stockMovements.count()).toBe(0);
  });

  it('R-KEG-2 links keg sales to the keg on tap, not to shelf stock', async () => {
    const order = await recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'keg_1', qty: 1 }] });
    const [line] = await db.lines.where('order_id').equals(order.id).toArray();
    expect(line?.keg_id).toBe('k08');
    expect(await db.stockMovements.count()).toBe(0);
  });
});

describe('recordPayment (R-ORD-2…4)', () => {
  it('part payment keeps the order open and lowers what is due', async () => {
    await recordPayment(db, ctx, 'o_047', [{ method: 'cash', amount_kes: 500 }]);
    expect((await db.orders.get('o_047'))?.status).toBe('open');
    const [lines, payments] = await Promise.all([
      db.lines.where('order_id').equals('o_047').toArray(),
      db.payments.where('order_id').equals('o_047').toArray(),
    ]);
    expect(orderDue(lines, payments)).toBe(750);
  });

  it('paying the rest marks the order paid, so it leaves Open orders', async () => {
    await recordPayment(db, ctx, 'o_044', [{ method: 'mpesa', amount_kes: 850, mpesa_ref_last4: 'qk7x' }]);
    expect((await db.orders.get('o_044'))?.status).toBe('paid');
    const payments = await db.payments.where('order_id').equals('o_044').toArray();
    expect(payments.find((p) => p.method === 'mpesa')).toMatchObject({ mpesa_ref_last4: 'QK7X', recorded_by: 'p_wanjiku' });
    expect(await db.orders.where('status').equals('open').count()).toBe(4);
  });

  it('a split payment is two rows recorded together in one event', async () => {
    const rows = await recordPayment(db, ctx, 'o_048', [
      { method: 'cash', amount_kes: 200 },
      { method: 'mpesa', amount_kes: 400 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.created_at).toBe(rows[1]?.created_at);
    expect((await db.orders.get('o_048'))?.status).toBe('paid');
    expect(await pendingEvents(db)).toHaveLength(1);
  });

  it('refuses more than is due, a bad M-Pesa code, and orders that are not open', async () => {
    await expect(recordPayment(db, ctx, 'o_048', [{ method: 'cash', amount_kes: 601 }])).rejects.toThrow(/600/);
    await expect(
      recordPayment(db, ctx, 'o_048', [{ method: 'mpesa', amount_kes: 600, mpesa_ref_last4: 'QK7' }]),
    ).rejects.toThrow(RangeError);
    await expect(recordPayment(db, ctx, 'o_048', [{ method: 'cash', amount_kes: 0 }])).rejects.toThrow(RangeError);
    expect(await db.payments.where('order_id').equals('o_048').count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);

    await recordPayment(db, ctx, 'o_048', [{ method: 'cash', amount_kes: 600 }]);
    await expect(recordPayment(db, ctx, 'o_048', [{ method: 'cash', amount_kes: 1 }])).rejects.toThrow(/not open/);
  });
});

describe('outbox (R-SYNC-1, R-SYNC-2)', () => {
  const sale = () => recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'soda_0', qty: 1 }] });

  it('keeps events in the order they happened, even if the clock steps back', async () => {
    const a = await recordOrder(db, at('2026-11-10T19:43:00.000Z'), { label: 'A', server_id: 'p_wanjiku', items: [{ size_id: 'soda_0', qty: 1 }] });
    const b = await recordOrder(db, at('2026-11-10T19:40:00.000Z'), { label: 'B', server_id: 'p_wanjiku', items: [{ size_id: 'soda_0', qty: 1 }] });
    await recordPayment(db, at('2026-11-10T19:41:00.000Z'), a.id, [{ method: 'cash', amount_kes: 70 }]);

    const pending = await pendingEvents(db);
    expect(pending.map((e) => e.type)).toEqual(['order_recorded', 'order_recorded', 'payment_recorded']);
    expect(pending.map((e) => (e.type === 'order_recorded' ? e.payload.order.id : e.type === 'payment_recorded' ? e.payload.order_id : null))).toEqual([a.id, b.id, a.id]);
    expect(new Set(pending.map((e) => e.id)).size).toBe(3);
  });

  it('saves the event and its effect together or not at all', async () => {
    // Fail the local apply part-way through: after the order, lines and stock level are written.
    const add = vi.spyOn(db.stockMovements, 'add').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(
      recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'tusker_0', qty: 1 }] }),
    ).rejects.toThrow('disk full');
    add.mockRestore();

    expect(await db.orders.count()).toBe(5);
    expect(await db.lines.count()).toBe(16);
    expect((await db.products.get('tusker'))?.stock_qty).toBe(24);
    expect(await db.outbox.count()).toBe(0);
  });

  it('survives closing and reopening the database (a phone restart)', async () => {
    await sale();
    const name = db.name;
    db.close();
    db = new KauntaDB(name);
    expect(await pendingEvents(db)).toHaveLength(1);
    expect(await db.orders.count()).toBe(6);
  });

  it('feeds the sync pill: waiting, then synced, and needs-admin is kept apart', async () => {
    const online = async (isOnline: boolean) => syncPillStatus({ online: isOnline, sending: 0, ...(await outboxCounts(db)) });
    expect(await online(true)).toEqual({ state: 'synced', count: 0 });

    await sale();
    await sale();
    await sale();
    expect(await online(true)).toEqual({ state: 'waiting', count: 3 });
    expect(await online(false)).toEqual({ state: 'offline', count: 3 });

    const [first, second, third] = await pendingEvents(db);
    await noteAttempt(db, [first!.id]);
    await markSent(db, [first!.id, second!.id], '2026-11-10T19:45:00.000Z');
    expect(await online(true)).toEqual({ state: 'waiting', count: 1 });
    expect(await db.outbox.where('id').equals(first!.id).first()).toMatchObject({
      status: 'sent',
      synced_at: '2026-11-10T19:45:00.000Z',
      attempts: 1,
    });

    await markNeedsReview(db, third!.id, 'price_mismatch', '2026-11-10T19:45:00.000Z');
    expect(await online(true)).toEqual({ state: 'needsAdmin', count: 1 });
    expect(await pendingEvents(db)).toHaveLength(0);
  });
});
