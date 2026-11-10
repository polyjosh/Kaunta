import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orderDue, orderTotal } from '../domain/orders';
import { blocksShiftClose, expectedCash, shiftResult } from '../domain/shifts';
import { clockMinutes, selfVoidMsLeft, voidRoute } from '../domain/voids';
import { recordOrder, recordPayment } from './commands';
import { KauntaDB } from './db';
import { pendingEvents } from './outbox';
import type { RecordContext } from './outbox';
import { seedDatabase } from './seedDb';
import { closeShift, handOverOrder, shiftSummary, startShift } from './shifts';
import { voidLines } from './voids';

let db: KauntaDB;
let n = 0;
const T0 = '2026-11-10T19:20:00.000Z'; // 22:20 Nairobi
const at = (iso: string, person = 'p_wanjiku'): RecordContext => ({ person_id: person, device_id: 'd_counter1', now: () => new Date(iso) });
const plus = (seconds: number, person?: string) => at(new Date(Date.parse(T0) + seconds * 1000).toISOString(), person);

beforeEach(async () => {
  db = new KauntaDB(`kaunta-vs-${++n}`);
  await seedDatabase(db, { now: new Date(T0) });
});
afterEach(() => db.delete());

const linesOf = (orderId: string) => db.lines.where('order_id').equals(orderId).toArray();
const stock = async (id: string) => (await db.products.get(id))!.stock_qty;
const sale = (ctx: RecordContext, items = [{ size_id: 'tusker_0', qty: 2 }]) =>
  recordOrder(db, ctx, { label: 'Table 4', server_id: 'p_wanjiku', items });

describe('void rules (R-VOID-1…3)', () => {
  const now = new Date(T0);
  const line = (secondsAgo: number, by = 'me') => ({
    created_at: new Date(now.getTime() - secondsAgo * 1000).toISOString(),
    recorded_by: by,
  });

  it('gives the recorder 5 minutes from when the line was recorded', () => {
    expect(selfVoidMsLeft([line(108)], 'me', now, 5)).toBe(192_000); // "closes in 3:12"
    expect(clockMinutes(192_000)).toBe('3:12');
    expect(clockMinutes(108_000)).toBe('1:48');
    expect(selfVoidMsLeft([line(300)], 'me', now, 5)).toBe(0);
    expect(selfVoidMsLeft([line(24 * 60)], 'me', now, 5)).toBe(0);
  });

  it('never grants more than the window, even for a line stamped in the future', () => {
    expect(selfVoidMsLeft([line(-7200)], 'me', now, 5)).toBe(300_000);
  });

  it('gives nobody else a window, and uses the oldest line for a whole order', () => {
    expect(selfVoidMsLeft([line(60, 'someone')], 'me', now, 5)).toBe(0);
    expect(selfVoidMsLeft([line(60), line(60, 'someone')], 'me', now, 5)).toBe(0);
    expect(selfVoidMsLeft([line(60), line(240)], 'me', now, 5)).toBe(60_000);
  });

  it('routes by reason and window', () => {
    for (const reason of ['mistake', 'changed', 'size'] as const) {
      expect(voidRoute(reason, 1000)).toEqual({ route: 'self', kind: 'void' });
      expect(voidRoute(reason, 0)).toEqual({ route: 'approval', kind: 'void' });
    }
    expect(voidRoute('other', 1000)).toEqual({ route: 'approval', kind: 'void' }); // always admin
    expect(voidRoute('spilled', 1000)).toEqual({ route: 'approval', kind: 'write_off' }); // write-off, always admin
    expect(voidRoute('mistake', 1000, true)).toEqual({ route: 'approval', kind: 'void' }); // money would go back
  });
});

describe('voidLines', () => {
  it('R-VOID-1 self-void inside the window: one unit comes off, stock goes back, the rest stays', async () => {
    const order = await sale(plus(0));
    const [line] = await linesOf(order.id);
    expect(await stock('tusker')).toBe(22);

    const outcome = await voidLines(db, plus(108), {
      order_id: order.id,
      items: [{ line_id: line!.id, qty: 1 }],
      whole_order: false,
      reason: 'mistake',
    });
    expect(outcome).toEqual({ route: 'self', kind: 'void', amount_kes: 300 });

    const lines = await linesOf(order.id);
    expect(lines.map((l) => [l.qty, l.status]).sort()).toEqual([
      [1, 'active'],
      [1, 'voided'],
    ]);
    expect(orderTotal(lines)).toBe(300);
    expect(await stock('tusker')).toBe(23);
    expect((await db.orders.get(order.id))?.status).toBe('open');
    expect(await db.approvals.count()).toBe(0);

    const movement = await db.stockMovements.where('ref_id').equals(lines.find((l) => l.status === 'voided')!.id).first();
    expect(movement).toMatchObject({ delta: 1, reason: 'void_return' });
    expect((await pendingEvents(db)).at(-1)).toMatchObject({ type: 'void_recorded', recorded_by: 'p_wanjiku' });
  });

  it('voiding the whole order marks it voided, so it leaves Open orders', async () => {
    const order = await sale(plus(0));
    await voidLines(db, plus(60), { order_id: order.id, items: [], whole_order: true, reason: 'changed' });
    expect((await db.orders.get(order.id))?.status).toBe('voided');
    expect(await stock('tusker')).toBe(24);
  });

  it('R-VOID-2 outside the window it waits for an admin and still counts toward the total', async () => {
    const order = await sale(plus(0));
    const outcome = await voidLines(db, plus(301), { order_id: order.id, items: [], whole_order: true, reason: 'mistake' });
    expect(outcome.route).toBe('approval');

    const lines = await linesOf(order.id);
    expect(lines.every((l) => l.status === 'void_pending')).toBe(true);
    expect(orderTotal(lines)).toBe(600);
    expect((await db.orders.get(order.id))?.status).toBe('open');
    expect(await stock('tusker')).toBe(22); // not returned until approved

    expect(await db.approvals.toArray()).toMatchObject([
      {
        kind: 'void',
        amount_kes: 600,
        reason_code: 'mistake',
        requested_by: 'p_wanjiku',
        device_id: 'd_counter1',
        status: 'waiting',
        target: { order_id: order.id, whole_order: true },
      },
    ]);
  });

  it('R-VOID-2 "Something else" always goes to an admin, even seconds after the sale', async () => {
    const order = await sale(plus(0));
    const outcome = await voidLines(db, plus(5), { order_id: order.id, items: [], whole_order: true, reason: 'other' });
    expect(outcome).toMatchObject({ route: 'approval', kind: 'void' });
  });

  it('R-VOID-3 "Spilled or broken" is a write-off needing approval; stock is not returned', async () => {
    const order = await sale(plus(0));
    const [line] = await linesOf(order.id);
    const outcome = await voidLines(db, plus(5), {
      order_id: order.id,
      items: [{ line_id: line!.id, qty: 2 }],
      whole_order: false,
      reason: 'spilled',
    });
    expect(outcome).toEqual({ route: 'approval', kind: 'write_off', amount_kes: 600 });
    expect((await db.approvals.toArray())[0]).toMatchObject({ kind: 'write_off', reason_code: 'spilled' });
    expect(await stock('tusker')).toBe(22);
  });

  it('someone else’s line needs an admin, however fresh', async () => {
    const order = await sale(plus(0));
    const outcome = await voidLines(db, plus(5, 'p_kiprop'), { order_id: order.id, items: [], whole_order: true, reason: 'mistake' });
    expect(outcome.route).toBe('approval');
    expect((await db.approvals.toArray())[0]?.requested_by).toBe('p_kiprop');
  });

  it('a void that would leave the order paid for more than it is worth goes to an admin', async () => {
    const order = await sale(plus(0));
    await recordPayment(db, plus(10), order.id, [{ method: 'cash', amount_kes: 400 }]);
    const [line] = await linesOf(order.id);
    const outcome = await voidLines(db, plus(20), {
      order_id: order.id,
      items: [{ line_id: line!.id, qty: 1 }],
      whole_order: false,
      reason: 'mistake',
    });
    expect(outcome.route).toBe('approval'); // KES 400 paid, only KES 300 would remain
  });

  it('rejects impossible requests without saving anything', async () => {
    const order = await sale(plus(0));
    const [line] = await linesOf(order.id);
    const before = (await pendingEvents(db)).length;
    await expect(
      voidLines(db, plus(5), { order_id: order.id, items: [{ line_id: line!.id, qty: 3 }], whole_order: false, reason: 'mistake' }),
    ).rejects.toThrow(RangeError);
    await expect(voidLines(db, plus(5), { order_id: order.id, items: [], whole_order: false, reason: 'mistake' })).rejects.toThrow(RangeError);
    expect((await pendingEvents(db)).length).toBe(before);
  });
});

describe('shift rules (R-SHIFT-1, R-SHIFT-2)', () => {
  it('expected = float + cash payments − expenses', () => {
    const shift = { float_kes: 2000, expenses: [{ label: 'Ice', amount_kes: 700 }, { label: 'Airtime', amount_kes: 500 }], cash_baseline_kes: 0 };
    const payments = [
      { method: 'cash' as const, amount_kes: 11950 },
      { method: 'mpesa' as const, amount_kes: 18400 }, // never in the drawer
    ];
    expect(expectedCash(shift, payments)).toBe(12750);
  });

  it('result is Matches, Over or Short, always as a magnitude', () => {
    expect(shiftResult(12750, 12750)).toEqual({ kind: 'matches', amount_kes: 0 });
    expect(shiftResult(12900, 12750)).toEqual({ kind: 'over', amount_kes: 150 });
    expect(shiftResult(12450, 12750)).toEqual({ kind: 'short', amount_kes: 300 });
  });

  it('an order blocks the close unless paid, voided, void-requested or handed over', () => {
    const shift = { person_id: 'me', device_id: 'd1' };
    const order = { status: 'open' as const, recorded_by: 'me', handed_over_to: null, handover_pending: false, device_id: 'd1' };
    const active = [{ status: 'active' as const }];
    expect(blocksShiftClose(order, active, shift)).toBe(true);
    expect(blocksShiftClose({ ...order, status: 'paid' }, active, shift)).toBe(false);
    expect(blocksShiftClose({ ...order, status: 'voided' }, active, shift)).toBe(false);
    expect(blocksShiftClose({ ...order, handover_pending: true }, active, shift)).toBe(false);
    expect(blocksShiftClose(order, [{ status: 'void_pending' }, { status: 'voided' }], shift)).toBe(false);
    expect(blocksShiftClose(order, [{ status: 'void_pending' }, { status: 'active' }], shift)).toBe(true);
    expect(blocksShiftClose({ ...order, recorded_by: 'other' }, active, shift)).toBe(false);
    expect(blocksShiftClose({ ...order, recorded_by: 'other', handed_over_to: 'me' }, active, shift)).toBe(true);
    expect(blocksShiftClose({ ...order, device_id: 'd2' }, active, shift)).toBe(false);
  });
});

describe('shifts in the store', () => {
  const wanjiku = at(T0);

  it('seeds Wanjiku’s shift as open with the designed numbers: expected KES 12,750', async () => {
    const summary = (await shiftSummary(db, 'p_wanjiku', 'd_counter1'))!;
    expect(summary.shift).toMatchObject({ float_kes: 2000, closed_at: null });
    expect(summary.cash_sales_kes).toBe(11950);
    expect(summary.expected_cash_kes).toBe(12750);
    expect(summary.mpesa_kes).toBe(18400);
    expect(summary.blocking.map((o) => o.short_no)).toEqual(['#044', '#047', '#048']);
    expect(await db.shifts.get('s_p_mwangi')).toMatchObject({ counted_cash_kes: 8820, result_kes: 0 });
  });

  it('counts cash taken during the shift, and never M-Pesa, into the drawer', async () => {
    await recordPayment(db, plus(10), 'o_048', [{ method: 'cash', amount_kes: 600 }]);
    await recordPayment(db, plus(20), 'o_047', [{ method: 'mpesa', amount_kes: 1250 }]);
    const summary = (await shiftSummary(db, 'p_wanjiku', 'd_counter1'))!;
    expect(summary.expected_cash_kes).toBe(13350);
    expect(summary.mpesa_kes).toBe(19650);
  });

  it('R-SHIFT-1 refuses to close while orders are open', async () => {
    await expect(closeShift(db, wanjiku, 12450)).rejects.toThrow(/3 open orders/);
    expect((await db.shifts.get('s_p_wanjiku'))?.closed_at).toBeNull();
  });

  it('closes once every order is paid, void-requested or handed over, and records counted and result', async () => {
    await recordPayment(db, plus(10), 'o_048', [{ method: 'mpesa', amount_kes: 600 }]);
    await voidLines(db, plus(20), { order_id: 'o_047', items: [], whole_order: true, reason: 'mistake' }); // old → approval
    await handOverOrder(db, plus(30), 'o_044');
    expect((await shiftSummary(db, 'p_wanjiku', 'd_counter1'))!.blocking).toHaveLength(0);

    expect(await closeShift(db, plus(40), 12450)).toEqual({ kind: 'short', amount_kes: 300 });
    expect(await db.shifts.get('s_p_wanjiku')).toMatchObject({
      counted_cash_kes: 12450,
      result_kes: -300,
      closed_at: new Date(Date.parse(T0) + 40_000).toISOString(),
    });
    expect((await pendingEvents(db)).at(-1)).toMatchObject({
      type: 'shift_closed',
      payload: { expected_cash_kes: 12750, counted_cash_kes: 12450, result_kes: -300 },
    });
  });

  it('R-ORD-6 a handed-over order goes to the next person who logs in on this device', async () => {
    await handOverOrder(db, plus(30), 'o_044');
    expect(await db.orders.get('o_044')).toMatchObject({ handover_pending: true, handed_over_to: null, status: 'open' });

    const shift = await startShift(db, plus(600, 'p_kiprop'));
    expect(shift).toMatchObject({ person_id: 'p_kiprop', float_kes: 0, closed_at: null });
    expect(await db.orders.get('o_044')).toMatchObject({ handover_pending: false, handed_over_to: 'p_kiprop', recorded_by: 'p_wanjiku' });
    expect((await shiftSummary(db, 'p_kiprop', 'd_counter1'))!.blocking.map((o) => o.short_no)).toEqual(['#044']);
    expect((await pendingEvents(db)).map((e) => e.type)).toEqual(['order_handed_over', 'shift_opened', 'handover_accepted']);
  });

  it('logging in again continues the open shift instead of opening another', async () => {
    const first = await startShift(db, wanjiku);
    const again = await startShift(db, plus(60));
    expect(again.id).toBe(first.id);
    expect(first.id).toBe('s_p_wanjiku');
    expect(await db.shifts.where('person_id').equals('p_wanjiku').count()).toBe(1);
  });

  it('a new shift only counts payments taken after it opened', async () => {
    await startShift(db, plus(0, 'p_kiprop'));
    const order = await sale(plus(10, 'p_kiprop'));
    await recordPayment(db, plus(20, 'p_kiprop'), order.id, [{ method: 'cash', amount_kes: 600 }]);
    const summary = (await shiftSummary(db, 'p_kiprop', 'd_counter1'))!;
    expect(summary.expected_cash_kes).toBe(600);
    expect(orderDue(await linesOf(order.id), await db.payments.where('order_id').equals(order.id).toArray())).toBe(0);
  });
});
