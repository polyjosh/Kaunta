import { lineTotal, orderDue, orderTotal, paidTotal } from './orders';
import type { ApprovalItem, ApprovalStatus, BusinessDay, Id, Order, OrderLine, Payment, Shift } from './types';

export type SalesFilter = 'all' | 'pending' | 'paid' | 'cancelled';

/** Where a void on an order stands: asked and waiting, decided by an admin, or done at the counter within the self-void window. */
export type VoidState =
  | { kind: 'approval'; status: Exclude<ApprovalStatus, 'cancelled'>; decided_by: Id | null }
  | { kind: 'self' };

export interface ShiftSale {
  order: Order;
  /** Active and waiting lines (what the order is worth now). */
  total: number;
  paid: number;
  due: number;
  /** Lines voided or waiting for a void decision. */
  voided_kes: number;
  items: number;
  void: VoidState | null;
}

/**
 * This person's orders in their open shift on this phone: served or recorded
 * by them since the shift started, and orders handed over to them whenever
 * they were opened. One they handed over to someone else is that person's.
 * Newest first.
 */
export function shiftSales(
  shift: Shift,
  personId: Id,
  orders: readonly Order[],
  lines: readonly OrderLine[],
  payments: readonly Payment[],
  approvals: readonly ApprovalItem[],
): ShiftSale[] {
  return toSales(
    orders.filter(
      (o) =>
        // Handed to me: while open, and once settled if it was opened or paid in this shift.
        (o.handed_over_to === personId &&
          (o.status === 'open' ||
            o.created_at >= shift.opened_at ||
            payments.some((p) => p.order_id === o.id && p.created_at >= shift.opened_at))) ||
        // Handed over to someone else: theirs now.
        (o.handed_over_to === null &&
          o.device_id === shift.device_id &&
          o.created_at >= shift.opened_at &&
          (o.server_id === personId || o.recorded_by === personId)),
    ),
    lines,
    payments,
    approvals,
  );
}

/**
 * This person's sales on one business day, on any phone this one has heard
 * from: orders handed over to them, and orders they served or recorded and did
 * not hand over. For "another shift" on the Sales screen. Newest first.
 */
export function daySales(
  day: BusinessDay,
  personId: Id,
  orders: readonly Order[],
  lines: readonly OrderLine[],
  payments: readonly Payment[],
  approvals: readonly ApprovalItem[],
): ShiftSale[] {
  return toSales(
    orders.filter(
      (o) =>
        o.business_day === day &&
        (o.handed_over_to ? o.handed_over_to === personId : o.server_id === personId || o.recorded_by === personId),
    ),
    lines,
    payments,
    approvals,
  );
}

function toSales(
  orders: readonly Order[],
  lines: readonly OrderLine[],
  payments: readonly Payment[],
  approvals: readonly ApprovalItem[],
): ShiftSale[] {
  return orders
    .map((order) => {
      const own = lines.filter((l) => l.order_id === order.id);
      const paidIn = payments.filter((p) => p.order_id === order.id);
      const request = approvals
        .filter((a) => (a.kind === 'void' || a.kind === 'write_off') && a.target.order_id === order.id && a.status !== 'cancelled')
        .sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0];
      const voided_kes = own.reduce((sum, l) => (l.status === 'active' ? sum : sum + lineTotal(l)), 0);
      const voidState: VoidState | null = request
        ? { kind: 'approval', status: request.status as Exclude<ApprovalStatus, 'cancelled'>, decided_by: request.decided_by }
        : order.status === 'voided' || own.some((l) => l.status === 'voided')
          ? { kind: 'self' }
          : null;
      return {
        order,
        total: orderTotal(own),
        paid: paidTotal(paidIn),
        due: order.status === 'open' ? orderDue(own, paidIn) : 0,
        voided_kes,
        items: own.reduce((sum, l) => (l.status === 'voided' ? sum : sum + l.qty), 0),
        void: voidState,
      };
    })
    .sort((a, b) => b.order.created_at.localeCompare(a.order.created_at));
}

/** Pending = still open; Paid = paid in full; Cancelled = voided, or with a void asked for or done on some of it. */
export function inFilter(sale: ShiftSale, filter: SalesFilter): boolean {
  if (filter === 'pending') return sale.order.status === 'open';
  if (filter === 'paid') return sale.order.status === 'paid';
  if (filter === 'cancelled') return sale.order.status === 'voided' || sale.void !== null;
  return true;
}
