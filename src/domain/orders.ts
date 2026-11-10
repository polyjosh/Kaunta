import { minutesBetween } from './time';
import type { Instant, Order, OrderLine, OrderStatus, Payment } from './types';

type LineAmounts = Pick<OrderLine, 'qty' | 'unit_price_kes' | 'status'>;
type PaymentAmount = Pick<Payment, 'amount_kes'>;

export function lineTotal(line: Pick<OrderLine, 'qty' | 'unit_price_kes'>): number {
  return line.qty * line.unit_price_kes;
}

/**
 * Sum of lines that still count. A line waiting for a void decision counts
 * until an admin approves it (R-VOID-2); a voided line does not.
 */
export function orderTotal(lines: readonly LineAmounts[]): number {
  return lines.reduce((sum, line) => (line.status === 'voided' ? sum : sum + lineTotal(line)), 0);
}

export function paidTotal(payments: readonly PaymentAmount[]): number {
  return payments.reduce((sum, payment) => sum + payment.amount_kes, 0);
}

/** R-ORD-2: due = active lines − payments. Never negative. */
export function orderDue(lines: readonly LineAmounts[], payments: readonly PaymentAmount[]): number {
  return Math.max(0, orderTotal(lines) - paidTotal(payments));
}

export type PaymentState = 'pending' | 'partPaid' | 'paid';

/** R-ORD-2: paid when due ≤ 0; part paid when 0 < paid < total. */
export function paymentState(lines: readonly LineAmounts[], payments: readonly PaymentAmount[]): PaymentState {
  const total = orderTotal(lines);
  const paid = paidTotal(payments);
  if (paid >= total) return 'paid';
  return paid > 0 ? 'partPaid' : 'pending';
}

/** The stored status that follows from the money; a voided order stays voided. */
export function statusAfterPayment(
  current: OrderStatus,
  lines: readonly LineAmounts[],
  payments: readonly PaymentAmount[],
): OrderStatus {
  if (current === 'voided') return 'voided';
  return paymentState(lines, payments) === 'paid' ? 'paid' : 'open';
}

/** R-ORD-1: open for more than `ageingMinutes`. */
export function isAgeing(order: Pick<Order, 'status' | 'created_at'>, now: Instant | Date, ageingMinutes: number): boolean {
  return order.status === 'open' && minutesBetween(order.created_at, now) > ageingMinutes;
}

export interface DayTotals {
  served_kes: number;
  collected_kes: number;
  money_at_risk_kes: number;
}

/** R-DAY-4: served = Σ line totals that count; collected = Σ payments; at risk = the difference. */
export function dayTotals(lines: readonly LineAmounts[], payments: readonly PaymentAmount[]): DayTotals {
  const served_kes = orderTotal(lines);
  const collected_kes = paidTotal(payments);
  return { served_kes, collected_kes, money_at_risk_kes: served_kes - collected_kes };
}
