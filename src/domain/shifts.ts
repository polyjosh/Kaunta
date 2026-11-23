import type { ApprovalItem, Id, Order, OrderLine, Payment, Shift, ShiftExpense } from './types';

type ShiftMoney = Pick<Shift, 'float_kes' | 'expenses' | 'cash_baseline_kes'>;

/** Paid from the M-Pesa till; anything else (older records too) came out of the cash drawer. */
export const paidFromTill = (expense: Pick<ShiftExpense, 'paid_from'>): boolean => expense.paid_from === 'mpesa';

const NONE: ReadonlySet<Id> = new Set();

/**
 * Expenses an admin or manager rejected. Every expense waits for approval; it
 * counts while it waits and once approved, and stops counting when rejected
 * (whoever spent it is then short by that much).
 */
export function rejectedExpenses(approvals: readonly Pick<ApprovalItem, 'kind' | 'status' | 'target'>[]): Set<Id> {
  return new Set(approvals.filter((a) => a.kind === 'expense' && a.status === 'rejected' && a.target.expense_id).map((a) => a.target.expense_id!));
}

const counts = (expense: Pick<ShiftExpense, 'id'>, rejected: ReadonlySet<Id>) => !expense.id || !rejected.has(expense.id);

/** Expenses paid out of the cash drawer: what R-SHIFT-2 takes off the cash expected. */
export function expensesTotal(shift: Pick<Shift, 'expenses'>, rejected: ReadonlySet<Id> = NONE): number {
  return shift.expenses.reduce((sum, expense) => (paidFromTill(expense) || !counts(expense, rejected) ? sum : sum + expense.amount_kes), 0);
}

/** Expenses paid from the M-Pesa till: they lower what the till statement should show. */
export function tillExpensesTotal(shift: Pick<Shift, 'expenses'>, rejected: ReadonlySet<Id> = NONE): number {
  return shift.expenses.reduce((sum, expense) => (paidFromTill(expense) && counts(expense, rejected) ? sum + expense.amount_kes : sum), 0);
}

export const EXPENSE_LABEL_MAX = 60;

/** Payments this person took on this device since the shift opened. */
export function shiftPayments<P extends Pick<Payment, 'recorded_by' | 'device_id' | 'created_at' | 'method' | 'amount_kes'>>(
  shift: Pick<Shift, 'person_id' | 'device_id' | 'opened_at' | 'closed_at'>,
  payments: readonly P[],
): P[] {
  return payments.filter(
    (p) =>
      p.recorded_by === shift.person_id &&
      p.device_id === shift.device_id &&
      p.created_at >= shift.opened_at &&
      (shift.closed_at === null || p.created_at <= shift.closed_at),
  );
}

export function shiftCashSales(shift: ShiftMoney, payments: readonly Pick<Payment, 'method' | 'amount_kes'>[]): number {
  return payments.reduce((sum, p) => (p.method === 'cash' ? sum + p.amount_kes : sum), shift.cash_baseline_kes);
}

/** R-SHIFT-2: expected = float + cash payments in the shift − expenses (rejected ones left out). */
export function expectedCash(shift: ShiftMoney, payments: readonly Pick<Payment, 'method' | 'amount_kes'>[], rejected: ReadonlySet<Id> = NONE): number {
  return shift.float_kes + shiftCashSales(shift, payments) - expensesTotal(shift, rejected);
}

export interface ShiftResult {
  kind: 'matches' | 'over' | 'short';
  /** Always a magnitude: a shortfall is "Short KES 300", never a minus sign. */
  amount_kes: number;
}

/** R-SHIFT-2: result = counted − expected → Matches (0), Over (> 0), Short (< 0). */
export function shiftResult(countedKes: number, expectedKes: number): ShiftResult {
  const diff = countedKes - expectedKes;
  return { kind: diff === 0 ? 'matches' : diff > 0 ? 'over' : 'short', amount_kes: Math.abs(diff) };
}

/** Whose order it is now: whoever it was handed to, else whoever recorded it. */
export function orderOwner(order: Pick<Order, 'recorded_by' | 'handed_over_to'>): Id {
  return order.handed_over_to ?? order.recorded_by;
}

/**
 * R-SHIFT-1: an order still blocks the shift close while it is open, belongs
 * to this person on this device, has not been handed over, and is not fully
 * waiting on a void decision.
 */
export function blocksShiftClose(
  order: Pick<Order, 'status' | 'recorded_by' | 'handed_over_to' | 'handover_pending' | 'device_id'>,
  lines: readonly Pick<OrderLine, 'status'>[],
  shift: Pick<Shift, 'person_id' | 'device_id'>,
): boolean {
  if (order.status !== 'open' || order.handover_pending) return false;
  if (orderOwner(order) !== shift.person_id) return false;
  // Orders opened on this phone, or handed over to this person from anywhere.
  if (order.device_id !== shift.device_id && order.handed_over_to !== shift.person_id) return false;
  const live = lines.filter((line) => line.status !== 'voided');
  const voidRequested = live.length > 0 && live.every((line) => line.status === 'void_pending');
  return !voidRequested;
}
