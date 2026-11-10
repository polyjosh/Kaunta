import { uuidv7 } from '../domain/ids';
import { orderDue, orderTotal, paidTotal } from '../domain/orders';
import { nextShortNo, normaliseMpesaRef } from '../domain/payments';
import { isSellable } from '../domain/stock';
import { businessDayOf } from '../domain/time';
import type { Id, Order, OrderLine, Payment, PaymentMethod } from '../domain/types';
import type { KauntaDB } from './db';
import { nowOf, recordEvent } from './outbox';
import type { RecordContext } from './outbox';

function assertPositiveInt(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${what} must be a whole number above zero`);
}

type Stamp = Pick<OrderLine, 'recorded_by' | 'device_id' | 'created_at' | 'synced_at'>;

/**
 * R-SELL-1/2/5: lines priced as this phone has them right now, for sizes that
 * are sold and products not switched off. Keg sales link to the keg on tap.
 */
async function buildLines(
  db: KauntaDB,
  at: Date,
  stamp: Stamp,
  order_id: Id,
  items: readonly { size_id: Id; qty: number }[],
): Promise<OrderLine[]> {
  const lines: OrderLine[] = [];
  for (const item of items) {
    assertPositiveInt(item.qty, 'Quantity');
    const size = await db.sizes.get(item.size_id);
    if (!size || !size.enabled) throw new Error(`That size is not sold: ${item.size_id}`);
    const product = await db.products.get(size.product_id);
    if (!product || !isSellable(product)) throw new Error(`${product?.name ?? size.product_id} is out of stock`);
    const keg = await db.kegs.where('[product_id+status]').equals([product.id, 'active']).first();
    lines.push({
      ...stamp,
      id: uuidv7(at.getTime()),
      order_id,
      product_id: product.id,
      size_id: size.id,
      qty: item.qty,
      unit_price_kes: size.price_kes,
      status: 'active',
      keg_id: keg?.id ?? null,
    });
  }
  return lines;
}

export interface OrderDraft {
  label: string;
  server_id: Id;
  items: { size_id: Id; qty: number }[];
  /** "Record & paid": pays the full total by this method (R-SELL-4). Omit for pay later. */
  paid_by?: PaymentMethod;
}

/**
 * R-SELL-4 / R-SELL-5: records an order with the prices on this phone right
 * now. Keg sales are linked to the keg on tap (R-KEG-2). The order number is
 * provisional until the server confirms it (R-DAY-2).
 */
export async function recordOrder(db: KauntaDB, ctx: RecordContext, draft: OrderDraft): Promise<Order> {
  if (draft.items.length === 0) throw new RangeError('An order needs at least one item');
  const at = nowOf(ctx);
  const created_at = at.toISOString();
  const stamp = { recorded_by: ctx.person_id, device_id: ctx.device_id, created_at, synced_at: null };

  return db.transaction('rw', db.tables, async () => {
    const bar = await db.bar.toCollection().first();
    const business_day = businessDayOf(at, bar?.day_start);
    const order_id = uuidv7(at.getTime());
    const lines = await buildLines(db, at, stamp, order_id, draft.items);

    const total = orderDue(lines, []);
    const payments: Payment[] = draft.paid_by
      ? [{ ...stamp, id: uuidv7(at.getTime()), order_id, method: draft.paid_by, amount_kes: total, mpesa_ref_last4: null }]
      : [];

    const usedToday = await db.orders.where('business_day').equals(business_day).toArray();
    const order: Order = {
      ...stamp,
      id: order_id,
      short_no: nextShortNo(usedToday.map((o) => o.short_no)),
      short_no_provisional: true,
      label: draft.label,
      server_id: draft.server_id,
      business_day,
      status: draft.paid_by ? 'paid' : 'open',
      handed_over_to: null,
    };

    await recordEvent(db, ctx, { type: 'order_recorded', payload: { order, lines, payments } });
    return order;
  });
}

/** "Add items" from Order detail: more lines on an open order, recorded by whoever adds them. */
export async function addItems(
  db: KauntaDB,
  ctx: RecordContext,
  order_id: Id,
  items: readonly { size_id: Id; qty: number }[],
): Promise<OrderLine[]> {
  if (items.length === 0) throw new RangeError('Nothing to add');
  const at = nowOf(ctx);
  const stamp = { recorded_by: ctx.person_id, device_id: ctx.device_id, created_at: at.toISOString(), synced_at: null };
  return db.transaction('rw', db.tables, async () => {
    const order = await db.orders.get(order_id);
    if (!order) throw new Error(`No such order: ${order_id}`);
    if (order.status !== 'open') throw new Error(`Order ${order.short_no} is not open`);
    const lines = await buildLines(db, at, stamp, order_id, items);
    await recordEvent(db, ctx, { type: 'lines_added', payload: { order_id, lines } });
    return lines;
  });
}

/**
 * R-ORD-5 split by items: moves some units of some lines to a new order with
 * the same label and server. Payments stay where they are, so the order being
 * split must keep at least as much as has been paid on it, and at least one item.
 */
export async function moveToNewOrder(
  db: KauntaDB,
  ctx: RecordContext,
  from_order_id: Id,
  items: readonly { line_id: Id; qty: number }[],
): Promise<Order> {
  const at = nowOf(ctx);
  return db.transaction('rw', db.tables, async () => {
    const [from, lines, payments] = await Promise.all([
      db.orders.get(from_order_id),
      db.lines.where('order_id').equals(from_order_id).toArray(),
      db.payments.where('order_id').equals(from_order_id).toArray(),
    ]);
    if (!from) throw new Error(`No such order: ${from_order_id}`);
    if (from.status !== 'open') throw new Error(`Order ${from.short_no} is not open`);

    const wanted = items.filter((item) => item.qty > 0);
    if (wanted.length === 0) throw new RangeError('Nothing to move');
    let moving = 0;
    let movingKes = 0;
    const parts = wanted.map((item) => {
      // Only active lines move; one waiting on a void decision stays put.
      const line = lines.find((l) => l.id === item.line_id && l.status === 'active');
      if (!line) throw new Error(`That item cannot be moved: ${item.line_id}`);
      assertPositiveInt(item.qty, 'Quantity');
      if (item.qty > line.qty) throw new RangeError(`Cannot move ${item.qty} of ${line.qty}`);
      moving += item.qty;
      movingKes += item.qty * line.unit_price_kes;
      return { line_id: line.id, qty: item.qty, split_line_id: item.qty < line.qty ? uuidv7(at.getTime()) : null };
    });

    const staying = lines.filter((l) => l.status !== 'voided').reduce((sum, l) => sum + l.qty, 0) - moving;
    if (staying <= 0) throw new RangeError('Leave at least one item on the order');
    if (paidTotal(payments) > orderTotal(lines) - movingKes) {
      throw new RangeError(`KES ${paidTotal(payments)} is already paid on ${from.short_no}; that much has to stay`);
    }

    const usedThatDay = await db.orders.where('business_day').equals(from.business_day).toArray();
    const order: Order = {
      id: uuidv7(at.getTime()),
      short_no: nextShortNo(usedThatDay.map((o) => o.short_no)),
      short_no_provisional: true,
      label: from.label,
      server_id: from.server_id,
      business_day: from.business_day,
      status: 'open',
      handed_over_to: null,
      recorded_by: ctx.person_id,
      device_id: ctx.device_id,
      created_at: at.toISOString(),
      synced_at: null,
    };
    await recordEvent(db, ctx, { type: 'lines_moved', payload: { from_order_id, order, parts } });
    return order;
  });
}

export interface PaymentPart {
  method: PaymentMethod;
  amount_kes: number;
  mpesa_ref_last4?: string | null;
}

/**
 * R-ORD-2…4: records one payment, or the two rows of a split payment
 * together. Refuses to take more than is still due.
 */
export async function recordPayment(
  db: KauntaDB,
  ctx: RecordContext,
  order_id: Id,
  parts: readonly PaymentPart[],
): Promise<Payment[]> {
  if (parts.length === 0) throw new RangeError('A payment needs an amount');
  const at = nowOf(ctx);
  const created_at = at.toISOString();

  return db.transaction('rw', db.tables, async () => {
    const order = await db.orders.get(order_id);
    if (!order) throw new Error(`No such order: ${order_id}`);
    if (order.status !== 'open') throw new Error(`Order ${order.short_no} is not open`);

    const payments: Payment[] = parts.map((part) => {
      assertPositiveInt(part.amount_kes, 'Amount');
      return {
        id: uuidv7(at.getTime()),
        order_id,
        method: part.method,
        amount_kes: part.amount_kes,
        mpesa_ref_last4: part.method === 'mpesa' ? normaliseMpesaRef(part.mpesa_ref_last4) : null,
        recorded_by: ctx.person_id,
        device_id: ctx.device_id,
        created_at,
        synced_at: null,
      };
    });

    const [lines, earlier] = await Promise.all([
      db.lines.where('order_id').equals(order_id).toArray(),
      db.payments.where('order_id').equals(order_id).toArray(),
    ]);
    const due = orderDue(lines, earlier);
    const received = payments.reduce((sum, p) => sum + p.amount_kes, 0);
    if (received > due) throw new RangeError(`Only KES ${due} is still due on ${order.short_no}`);

    await recordEvent(db, ctx, { type: 'payment_recorded', payload: { order_id, payments } });
    return payments;
  });
}
