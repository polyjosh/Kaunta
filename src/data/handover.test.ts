import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { byServer } from '../domain/admin';
import { blocksShiftClose } from '../domain/shifts';
import type { Shift } from '../domain/types';
import { KauntaDB } from './db';
import { seedDatabase } from './seedDb';
import { handOverOrder, unsettledShiftsOf } from './shifts';

let db: KauntaDB;
let n = 0;
const ctx = { person_id: 'p_wanjiku', device_id: 'd_counter1', now: () => new Date('2026-11-10T19:43:00.000Z') };

beforeEach(async () => {
  db = new KauntaDB(`kaunta-handover-${++n}`);
  await seedDatabase(db);
});
afterEach(() => db.delete());

const shiftOf = (person_id: string, device_id: string): Shift => ({
  id: `s_${person_id}_${device_id}`, person_id, device_id, opened_at: '2026-11-10T15:00:00.000Z', float_kes: 0, expenses: [],
  closed_at: null, counted_cash_kes: null, result_kes: null, cash_baseline_kes: 0, mpesa_baseline_kes: 0,
});

describe('handing an order over to someone', () => {
  it('makes it theirs: off my shift close, on theirs (even on another phone), and their sales in admin', async () => {
    await handOverOrder(db, ctx, 'o_047', 'p_kiprop');
    const order = (await db.orders.get('o_047'))!;
    expect(order).toMatchObject({ handed_over_to: 'p_kiprop', handover_pending: false });
    expect(blocksShiftClose(order, [], shiftOf('p_wanjiku', 'd_counter1'))).toBe(false);
    expect(blocksShiftClose(order, [], shiftOf('p_kiprop', 'd_counter2'))).toBe(true);

    const [orders, lines, payments] = await Promise.all([db.orders.toArray(), db.lines.toArray(), db.payments.toArray()]);
    const kiprop = byServer({ orders, lines, payments }).find((t) => t.person_id === 'p_kiprop')!;
    const wanjiku = byServer({ orders, lines, payments }).find((t) => t.person_id === 'p_wanjiku');
    expect(kiprop.not_paid_kes).toBeGreaterThanOrEqual(1250);
    expect(wanjiku?.orders ?? 0).toBe(orders.filter((o) => (o.handed_over_to ?? o.server_id) === 'p_wanjiku').length);
  });

  it('refuses handing over to yourself or to someone unknown', async () => {
    await expect(handOverOrder(db, ctx, 'o_047', 'p_wanjiku')).rejects.toThrow();
    await expect(handOverOrder(db, ctx, 'o_047', 'p_nobody')).rejects.toThrow();
  });
});

describe('a new shift waits while the last one has unpaid orders', () => {
  it('finds my open shift on another phone with my unpaid orders, until they are settled', async () => {
    await db.shifts.put(shiftOf('p_wanjiku', 'd_counter2'));
    await db.orders.update('o_047', { device_id: 'd_counter2' });
    const found = await unsettledShiftsOf(db, 'p_wanjiku', 'd_counter1');
    expect(found).toHaveLength(1);
    expect(found[0]!.orders.map((o) => o.id)).toEqual(['o_047']);
    expect(found[0]!.due_kes).toBe(1250);

    await db.orders.update('o_047', { status: 'paid' });
    expect(await unsettledShiftsOf(db, 'p_wanjiku', 'd_counter1')).toEqual([]);
  });

  it('ignores an open shift with nothing unpaid, and the shift on this phone (that one carries on)', async () => {
    await db.shifts.put(shiftOf('p_wanjiku', 'd_counter2'));
    expect(await unsettledShiftsOf(db, 'p_wanjiku', 'd_counter1')).toEqual([]);
    // From the other phone, the seeded Counter 1 shift and its unpaid orders do count.
    expect((await unsettledShiftsOf(db, 'p_wanjiku', 'd_counter2')).map((u) => u.shift.device_id)).toEqual(['d_counter1']);
  });
});
