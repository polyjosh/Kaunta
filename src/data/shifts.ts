import { uuidv7 } from '../domain/ids';
import { blocksShiftClose, expectedCash, shiftCashSales, shiftPayments, shiftResult } from '../domain/shifts';
import type { ShiftResult } from '../domain/shifts';
import type { Id, Order, Payment, Shift } from '../domain/types';
import type { KauntaDB } from './db';
import { nowOf, recordEvent } from './outbox';
import type { RecordContext } from './outbox';

export async function openShiftOf(db: KauntaDB, person_id: Id, device_id: Id): Promise<Shift | undefined> {
  const shifts = await db.shifts.where('[person_id+device_id]').equals([person_id, device_id]).toArray();
  return shifts.find((shift) => shift.closed_at === null);
}

/**
 * Called at login. Opens a shift for this person on this device if they have
 * none, and gives them any orders the previous shift handed over (R-ORD-6).
 * A new shift starts with a float of zero: the designs have no screen for
 * entering a float or expenses yet.
 */
export async function startShift(db: KauntaDB, ctx: RecordContext): Promise<Shift> {
  const at = nowOf(ctx);
  return db.transaction('rw', db.tables, async () => {
    let shift = await openShiftOf(db, ctx.person_id, ctx.device_id);
    if (!shift) {
      shift = {
        id: uuidv7(at.getTime()),
        person_id: ctx.person_id,
        device_id: ctx.device_id,
        opened_at: at.toISOString(),
        float_kes: 0,
        expenses: [],
        closed_at: null,
        counted_cash_kes: null,
        result_kes: null,
        cash_baseline_kes: 0,
        mpesa_baseline_kes: 0,
      };
      await recordEvent(db, ctx, { type: 'shift_opened', payload: { shift } });
    }

    const waiting = (await db.orders.where('status').equals('open').toArray()).filter(
      (order) => order.handover_pending && order.device_id === ctx.device_id,
    );
    if (waiting.length > 0) {
      await recordEvent(db, ctx, {
        type: 'handover_accepted',
        payload: { order_ids: waiting.map((order) => order.id), person_id: ctx.person_id },
      });
    }
    return shift;
  });
}

export interface ShiftSummary {
  shift: Shift;
  /** Orders that must be paid, voided or handed over first (R-SHIFT-1). */
  blocking: Order[];
  payments: Payment[];
  cash_sales_kes: number;
  mpesa_kes: number;
  expected_cash_kes: number;
}

export async function shiftSummary(db: KauntaDB, person_id: Id, device_id: Id): Promise<ShiftSummary | null> {
  const shift = await openShiftOf(db, person_id, device_id);
  if (!shift) return null;
  const [orders, allPayments] = await Promise.all([
    db.orders.where('status').equals('open').toArray(),
    db.payments.toArray(),
  ]);
  const lines = await db.lines.where('order_id').anyOf(orders.map((o) => o.id)).toArray();
  const payments = shiftPayments(shift, allPayments);
  const expected_cash_kes = expectedCash(shift, payments);
  return {
    shift,
    blocking: orders
      .filter((order) => blocksShiftClose(order, lines.filter((l) => l.order_id === order.id), shift))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    payments,
    cash_sales_kes: shiftCashSales(shift, payments),
    mpesa_kes: payments.reduce((sum, p) => (p.method === 'mpesa' ? sum + p.amount_kes : sum), shift.mpesa_baseline_kes),
    expected_cash_kes,
  };
}

/** R-ORD-6: leave an open order for the next person who logs in on this device. */
export async function handOverOrder(db: KauntaDB, ctx: RecordContext, order_id: Id): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const order = await db.orders.get(order_id);
    if (!order || order.status !== 'open') throw new Error(`Only an open order can be handed over: ${order_id}`);
    await recordEvent(db, ctx, { type: 'order_handed_over', payload: { order_id, from: ctx.person_id } });
  });
}

/**
 * R-SHIFT-1 / R-SHIFT-2: closes the shift with the cash counted. Refuses
 * while any order still blocks it. Expected and result are fixed here, at
 * close, so later corrections never rewrite what the count was compared with.
 */
export async function closeShift(db: KauntaDB, ctx: RecordContext, countedCashKes: number): Promise<ShiftResult> {
  if (!Number.isSafeInteger(countedCashKes) || countedCashKes < 0) {
    throw new RangeError('Cash counted must be a whole number of KES');
  }
  const at = nowOf(ctx);
  return db.transaction('rw', db.tables, async () => {
    const summary = await shiftSummary(db, ctx.person_id, ctx.device_id);
    if (!summary) throw new Error('No open shift to close');
    if (summary.blocking.length > 0) {
      throw new Error(`Settle ${summary.blocking.length} open orders before closing the shift`);
    }
    const result = shiftResult(countedCashKes, summary.expected_cash_kes);
    await recordEvent(db, ctx, {
      type: 'shift_closed',
      payload: {
        shift_id: summary.shift.id,
        closed_at: at.toISOString(),
        counted_cash_kes: countedCashKes,
        expected_cash_kes: summary.expected_cash_kes,
        result_kes: countedCashKes - summary.expected_cash_kes,
      },
    });
    return result;
  });
}
