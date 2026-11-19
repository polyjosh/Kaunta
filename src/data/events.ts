import { statusAfterPayment } from '../domain/orders';
import { saleDeduction } from '../domain/stock';
import { shiftStock } from './pools';
import type { ApprovalItem, Id, Instant, Order, OrderLine, Payment, Shift, ShiftExpense, VoidReason } from '../domain/types';
import type { KauntaDB } from './db';

/** One line, or some units of it, being voided. `split_line_id` is the new line that carries the voided units. */
export interface VoidPart {
  line_id: Id;
  qty: number;
  /** Set when only some of the line's units are voided; null when the whole line is. */
  split_line_id: Id | null;
}

/**
 * What a counter can record. Each event carries complete records (ids,
 * prices, authorship and device time already fixed on the device), so the
 * server stores what staff recorded rather than recomputing it (R-SYNC-3).
 */
export type KauntaEvent =
  | { type: 'order_recorded'; payload: { order: Order; lines: OrderLine[]; payments: Payment[] } }
  | { type: 'payment_recorded'; payload: { order_id: Id; payments: Payment[] } }
  /** "Add items" on an open order: new lines at today's prices, stock taken as for a sale. */
  | { type: 'lines_added'; payload: { order_id: Id; lines: OrderLine[] } }
  /**
   * R-ORD-5 split by items: lines (or some units of them) move to a new order.
   * Moved lines keep their author, time and price; `split_line_id` is the new
   * line that carries the moved units when only some of a line moves.
   */
  | { type: 'lines_moved'; payload: { from_order_id: Id; order: Order; parts: VoidPart[] } }
  /** A wrong PIN, and the lock it caused if it was the last allowed try (R-PIN-1). Audit-logged. */
  | { type: 'pin_failed'; payload: { person_id: Id; failed_pin_attempts: number; pin_locked_until: Instant | null } }
  | { type: 'logged_in'; payload: { person_id: Id } }
  /** R-PIN-2: a new PIN chosen at the counter with an admin's one-time code. Only its hash travels. */
  | { type: 'pin_set'; payload: { person_id: Id; pin_hash: string } }
  /** R-VOID-1: voided by the person who recorded it, inside the window. Stock goes back. */
  | { type: 'void_recorded'; payload: { order_id: Id; parts: VoidPart[]; reason: VoidReason; voided_at: Instant } }
  /** R-VOID-2/3: waits for an admin; the lines stay on the order as void_pending. */
  | { type: 'void_requested'; payload: { order_id: Id; parts: VoidPart[]; approval: ApprovalItem } }
  | { type: 'shift_opened'; payload: { shift: Shift } }
  /** Money paid out during the shift, from the cash drawer or the M-Pesa till; an admin or manager approves it. */
  | { type: 'shift_expense_added'; payload: { shift_id: Id; expense: ShiftExpense; approval?: ApprovalItem } }
  /** An expense recorded by mistake, taken off before anyone decided on it. */
  | { type: 'shift_expense_removed'; payload: { shift_id: Id; expense: ShiftExpense } }
  /** The order was paid after all: its void requests are taken back and the lines stand (counts as a sale). */
  | { type: 'void_request_cancelled'; payload: { order_id: Id; approval_ids: Id[] } }
  | {
      type: 'shift_closed';
      payload: { shift_id: Id; closed_at: Instant; counted_cash_kes: number; expected_cash_kes: number; result_kes: number };
    }
  /** R-ORD-6: left for the next person who logs in on this device. */
  | { type: 'order_handed_over'; payload: { order_id: Id; from: Id } }
  | { type: 'handover_accepted'; payload: { order_ids: Id[]; person_id: Id } };

export type OutboxStatus = 'pending' | 'sent' | 'needs_review';

export type OutboxEntry = KauntaEvent & {
  /** Send order; assigned by the local database. */
  seq?: number;
  /** Idempotency key for the server (R-SYNC-2). */
  id: Id;
  recorded_by: Id;
  device_id: Id;
  created_at: Instant;
  status: OutboxStatus;
  synced_at: Instant | null;
  attempts: number;
  /** Why the server flagged it, when status is needs_review. */
  review_reason: string | null;
  /** What the server said about it (e.g. the two prices in a price mismatch). */
  review_detail?: Record<string, unknown> | null;
};

/**
 * Applies an event to the local store. Must run inside the same transaction
 * that appends it to the outbox, so the two can never disagree.
 */
export async function applyEvent(db: KauntaDB, event: KauntaEvent): Promise<void> {
  switch (event.type) {
    case 'order_recorded': {
      const { order, lines, payments } = event.payload;
      await db.orders.add(order);
      await db.lines.bulkAdd(lines);
      await db.payments.bulkAdd(payments);
      for (const line of lines) await moveStock(db, line, -1, 'sale');
      return;
    }
    case 'payment_recorded': {
      const { order_id, payments } = event.payload;
      if (!(await db.orders.get(order_id))) throw new Error(`Payment for an order this phone does not have: ${order_id}`);
      await db.payments.bulkAdd(payments);
      await refreshOrderStatus(db, order_id);
      return;
    }
    case 'lines_added': {
      const { order_id, lines } = event.payload;
      if (!(await db.orders.get(order_id))) throw new Error(`Items for an order this phone does not have: ${order_id}`);
      await db.lines.bulkAdd(lines);
      for (const line of lines) await moveStock(db, line, -1, 'sale');
      await refreshOrderStatus(db, order_id);
      return;
    }
    case 'lines_moved': {
      const { from_order_id, order, parts } = event.payload;
      await db.orders.add(order);
      for (const part of parts) {
        const line = await db.lines.get(part.line_id);
        if (!line) throw new Error(`Move of a line this phone does not have: ${part.line_id}`);
        if (part.split_line_id && part.qty < line.qty) {
          await db.lines.update(line.id, { qty: line.qty - part.qty });
          await db.lines.add({ ...line, id: part.split_line_id, qty: part.qty, order_id: order.id });
        } else {
          await db.lines.update(line.id, { order_id: order.id });
        }
      }
      // What stays may now be fully covered by what was already paid.
      await refreshOrderStatus(db, from_order_id);
      return;
    }
    case 'pin_failed': {
      const { person_id, failed_pin_attempts, pin_locked_until } = event.payload;
      await db.people.update(person_id, { failed_pin_attempts, pin_locked_until });
      return;
    }
    case 'logged_in': {
      await db.people.update(event.payload.person_id, { failed_pin_attempts: 0, pin_locked_until: null });
      return;
    }
    case 'pin_set': {
      await db.people.update(event.payload.person_id, {
        pin_hash: event.payload.pin_hash,
        pin_reset_hash: null,
        pin_reset_expires_at: null,
        failed_pin_attempts: 0,
        pin_locked_until: null,
      });
      return;
    }
    case 'void_recorded': {
      const { order_id, parts } = event.payload;
      for (const line of await markLines(db, parts, 'voided')) await moveStock(db, line, +1, 'void_return');
      await refreshOrderStatus(db, order_id);
      return;
    }
    case 'void_requested': {
      const { parts, approval } = event.payload;
      // Still counts toward the total, and stock is untouched, until an admin decides (R-VOID-2…4).
      await markLines(db, parts, 'void_pending');
      await db.approvals.add(approval);
      return;
    }
    case 'shift_opened': {
      await db.shifts.add(event.payload.shift);
      return;
    }
    case 'shift_expense_added': {
      const shift = await db.shifts.get(event.payload.shift_id);
      if (shift && !shift.expenses.some((e) => e.id === event.payload.expense.id)) {
        await db.shifts.update(shift.id, { expenses: [...shift.expenses, event.payload.expense] });
      }
      if (event.payload.approval) await db.approvals.put(event.payload.approval);
      break;
    }
    case 'shift_expense_removed': {
      const shift = await db.shifts.get(event.payload.shift_id);
      if (shift) await db.shifts.update(shift.id, { expenses: shift.expenses.filter((e) => e.id !== event.payload.expense.id) });
      await db.approvals
        .filter((a) => a.kind === 'expense' && a.target.expense_id === event.payload.expense.id && a.status === 'waiting')
        .modify({ status: 'cancelled' });
      break;
    }
    case 'void_request_cancelled': {
      const approvals = (await db.approvals.bulkGet(event.payload.approval_ids)).filter((a) => a?.status === 'waiting');
      for (const a of approvals) {
        await db.lines.where('id').anyOf(a!.target.line_ids).and((l) => l.status === 'void_pending').modify({ status: 'active' });
        await db.approvals.update(a!.id, { status: 'cancelled' });
      }
      await refreshOrderStatus(db, event.payload.order_id);
      break;
    }
    case 'shift_closed': {
      const { shift_id, closed_at, counted_cash_kes, result_kes } = event.payload;
      await db.shifts.update(shift_id, { closed_at, counted_cash_kes, result_kes });
      return;
    }
    case 'order_handed_over': {
      await db.orders.update(event.payload.order_id, { handover_pending: true });
      return;
    }
    case 'handover_accepted': {
      const { order_ids, person_id } = event.payload;
      await db.orders.where('id').anyOf(order_ids).modify({ handed_over_to: person_id, handover_pending: false });
      return;
    }
  }
}

/**
 * Sets the status of the voided units and returns them as lines. When only
 * some units of a line are voided, the line is split: the rest stays as it
 * was, and a new line (same price, time and author) carries the voided units.
 */
async function markLines(db: KauntaDB, parts: readonly VoidPart[], status: 'voided' | 'void_pending'): Promise<OrderLine[]> {
  const changed: OrderLine[] = [];
  for (const part of parts) {
    const line = await db.lines.get(part.line_id);
    if (!line) throw new Error(`Void for a line this phone does not have: ${part.line_id}`);
    if (part.split_line_id && part.qty < line.qty) {
      await db.lines.update(line.id, { qty: line.qty - part.qty });
      const split: OrderLine = { ...line, id: part.split_line_id, qty: part.qty, status };
      await db.lines.add(split);
      changed.push(split);
    } else {
      await db.lines.update(line.id, { status });
      changed.push({ ...line, status });
    }
  }
  return changed;
}

/** Paid / open follows the money; an order with every line voided is voided. */
export async function refreshOrderStatus(db: KauntaDB, order_id: Id): Promise<void> {
  const order = await db.orders.get(order_id);
  if (!order) return;
  const [lines, payments] = await Promise.all([
    db.lines.where('order_id').equals(order_id).toArray(),
    db.payments.where('order_id').equals(order_id).toArray(),
  ]);
  const status = lines.every((line) => line.status === 'voided')
    ? 'voided'
    : statusAfterPayment(order.status, lines, payments);
  await db.orders.update(order_id, { status });
}

/**
 * R-STOCK-1 / R-VOID-4: a sale takes stock, an approved or self void puts it
 * back. Untracked products (food, kegs) have no shelf count to change.
 */
async function moveStock(db: KauntaDB, line: OrderLine, direction: 1 | -1, reason: 'sale' | 'void_return'): Promise<void> {
  const size = await db.sizes.get(line.size_id);
  if (!size) return;
  const delta = direction * saleDeduction(size, line.qty);
  const pool = await shiftStock(db, line.product_id, size.id, delta);
  if (pool === undefined) return;
  await db.stockMovements.add({
    id: `${line.id}:${reason}`,
    product_id: line.product_id,
    size_id: pool,
    delta,
    reason,
    ref_id: line.id,
    recorded_by: line.recorded_by,
    created_at: line.created_at,
  });
}
