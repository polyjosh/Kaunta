import { uuidv7 } from '../domain/ids';
import { EXPENSE_LABEL_MAX, blocksShiftClose, expectedCash, rejectedExpenses, shiftCashSales, shiftPayments, shiftResult } from '../domain/shifts';
import type { ShiftResult } from '../domain/shifts';
import type { ApprovalItem, ExpenseSource, Id, Order, Payment, Shift, ShiftExpense } from '../domain/types';
import type { KauntaDB } from './db';
import { nowOf, recordEvent } from './outbox';
import type { RecordContext } from './outbox';

export async function openShiftOf(db: KauntaDB, person_id: Id, device_id: Id): Promise<Shift | undefined> {
  const shifts = await db.shifts.where('[person_id+device_id]').equals([person_id, device_id]).toArray();
  return shifts.find((shift) => shift.closed_at === null);
}

/**
 * Called at login. Opens a shift for this person on this device if they have
 * none, with the cash float they counted into the drawer, and gives them any
 * orders the previous shift handed over (R-ORD-6). A shift already open on
 * this phone carries on with the float it started with.
 */
export async function startShift(db: KauntaDB, ctx: RecordContext, floatKes = 0): Promise<Shift> {
  if (!Number.isSafeInteger(floatKes) || floatKes < 0) throw new RangeError('The float must be a whole number of KES');
  const at = nowOf(ctx);
  return db.transaction('rw', db.tables, async () => {
    let shift = await openShiftOf(db, ctx.person_id, ctx.device_id);
    if (!shift) {
      shift = {
        id: uuidv7(at.getTime()),
        person_id: ctx.person_id,
        device_id: ctx.device_id,
        opened_at: at.toISOString(),
        float_kes: floatKes,
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
  /** Expenses of this shift an admin or manager rejected: they no longer count. */
  rejected: Set<Id>;
}

export async function shiftSummary(db: KauntaDB, person_id: Id, device_id: Id): Promise<ShiftSummary | null> {
  const shift = await openShiftOf(db, person_id, device_id);
  if (!shift) return null;
  const [orders, allPayments, approvals] = await Promise.all([
    db.orders.where('status').equals('open').toArray(),
    db.payments.toArray(),
    db.approvals.filter((a) => a.kind === 'expense').toArray(),
  ]);
  const lines = await db.lines.where('order_id').anyOf(orders.map((o) => o.id)).toArray();
  const payments = shiftPayments(shift, allPayments);
  const rejected = rejectedExpenses(approvals);
  const expected_cash_kes = expectedCash(shift, payments, rejected);
  return {
    shift,
    blocking: orders
      .filter((order) => blocksShiftClose(order, lines.filter((l) => l.order_id === order.id), shift))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    payments,
    cash_sales_kes: shiftCashSales(shift, payments),
    mpesa_kes: payments.reduce((sum, p) => (p.method === 'mpesa' ? sum + p.amount_kes : sum), shift.mpesa_baseline_kes),
    expected_cash_kes,
    rejected,
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

/**
 * Money paid out during the shift (ice, change for a supplier, airtime…),
 * from the cash drawer or the M-Pesa till. Cash expenses come off the cash
 * expected at close; till expenses off what the till statement should show.
 */
export async function addExpense(
  db: KauntaDB,
  ctx: RecordContext,
  expense: { label: string; amount_kes: number; paid_from: ExpenseSource },
): Promise<ShiftExpense> {
  const label = expense.label.trim().slice(0, EXPENSE_LABEL_MAX);
  if (!label) throw new RangeError('Say what the expense was for');
  if (!Number.isSafeInteger(expense.amount_kes) || expense.amount_kes <= 0) throw new RangeError('An expense must be a whole number of KES above 0');
  if (expense.paid_from !== 'cash' && expense.paid_from !== 'mpesa') throw new RangeError('Paid from the cash drawer or the M-Pesa till');
  const at = nowOf(ctx);
  return db.transaction('rw', db.tables, async () => {
    const shift = await openShiftOf(db, ctx.person_id, ctx.device_id);
    if (!shift) throw new Error('No open shift to add an expense to');
    const recorded: ShiftExpense = { id: uuidv7(at.getTime()), label, amount_kes: expense.amount_kes, paid_from: expense.paid_from, at: at.toISOString() };
    // Every expense goes to Approvals; it counts until an admin or manager rejects it.
    const approval: ApprovalItem = {
      id: uuidv7(at.getTime()),
      kind: 'expense',
      target: { order_id: null, line_ids: [], whole_order: false, shift_id: shift.id, expense_id: recorded.id },
      amount_kes: recorded.amount_kes,
      reason_code: recorded.paid_from!,
      requested_by: ctx.person_id,
      device_id: ctx.device_id,
      requested_at: recorded.at!,
      status: 'waiting',
      decided_by: null,
      decided_at: null,
      detail: { label },
    };
    await recordEvent(db, ctx, { type: 'shift_expense_added', payload: { shift_id: shift.id, expense: recorded, approval } });
    return recorded;
  });
}

/** Takes off an expense recorded by mistake, while the shift is open and nobody has decided on it yet. */
export async function removeExpense(db: KauntaDB, ctx: RecordContext, expenseId: Id): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const shift = await openShiftOf(db, ctx.person_id, ctx.device_id);
    const expense = shift?.expenses.find((e) => e.id === expenseId);
    if (!shift || !expense) throw new Error(`No such expense in the open shift: ${expenseId}`);
    const decided = await db.approvals.filter((a) => a.kind === 'expense' && a.target.expense_id === expenseId && a.status !== 'waiting' && a.status !== 'cancelled').count();
    if (decided > 0) throw new Error('This expense has been decided on and can no longer be removed');
    await recordEvent(db, ctx, { type: 'shift_expense_removed', payload: { shift_id: shift.id, expense } });
  });
}
