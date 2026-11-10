import type { Id, Order, OrderLine, Payment, Shift } from './types';

type ShiftMoney = Pick<Shift, 'float_kes' | 'expenses' | 'cash_baseline_kes'>;

export function expensesTotal(shift: Pick<Shift, 'expenses'>): number {
  return shift.expenses.reduce((sum, expense) => sum + expense.amount_kes, 0);
}

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

/** R-SHIFT-2: expected = float + cash payments in the shift − expenses. */
export function expectedCash(shift: ShiftMoney, payments: readonly Pick<Payment, 'method' | 'amount_kes'>[]): number {
  return shift.float_kes + shiftCashSales(shift, payments) - expensesTotal(shift);
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
  if (order.device_id !== shift.device_id || orderOwner(order) !== shift.person_id) return false;
  const live = lines.filter((line) => line.status !== 'voided');
  const voidRequested = live.length > 0 && live.every((line) => line.status === 'void_pending');
  return !voidRequested;
}
