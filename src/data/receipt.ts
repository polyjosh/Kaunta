import { lineTotal, orderDue, orderTotal, paidTotal } from '../domain/orders';
import type { Id, Instant, PaymentMethod, Product, ProductSize } from '../domain/types';
import type { KauntaDB } from './db';

export interface ReceiptLine {
  product: Pick<Product, 'name' | 'name_sw'> | null;
  size: Pick<ProductSize, 'label_en' | 'label_sw'> | null;
  qty: number;
  unit_price_kes: number;
  total_kes: number;
  /** Waiting for an admin's decision on a void: still on the bill until approved. */
  void_pending: boolean;
}

export interface ReceiptData {
  bar_name: string;
  order_id: Id;
  short_no: string;
  label: string;
  note: string | null;
  created_at: Instant;
  server: string;
  recorded_by: string;
  device: string;
  lines: ReceiptLine[];
  total_kes: number;
  payments: { method: PaymentMethod; amount_kes: number; mpesa_ref_last4: string | null }[];
  paid_kes: number;
  due_kes: number;
  /** The order was voided as a whole. */
  voided: boolean;
}

/** Everything a printed receipt shows for one order, from this phone's store (so it works offline). */
export async function loadReceipt(db: KauntaDB, orderId: Id): Promise<ReceiptData | null> {
  const order = await db.orders.get(orderId);
  if (!order) return null;
  const [bar, lines, payments, device] = await Promise.all([
    db.bar.toCollection().first(),
    db.lines.where('order_id').equals(orderId).sortBy('created_at'),
    db.payments.where('order_id').equals(orderId).sortBy('created_at'),
    db.devices.get(order.device_id),
  ]);
  const [products, sizes, people] = await Promise.all([
    db.products.bulkGet([...new Set(lines.map((l) => l.product_id))]),
    db.sizes.bulkGet([...new Set(lines.map((l) => l.size_id))]),
    db.people.bulkGet([...new Set([order.server_id, order.recorded_by])]),
  ]);
  const nameOf = (id: Id) => people.find((p) => p?.id === id)?.name ?? '';
  const kept = lines.filter((l) => l.status !== 'voided');
  return {
    bar_name: bar?.name ?? '',
    order_id: order.id,
    short_no: order.short_no,
    label: order.label,
    note: order.note ?? null,
    created_at: order.created_at,
    server: nameOf(order.server_id),
    recorded_by: nameOf(order.recorded_by),
    device: device?.name ?? '',
    lines: kept.map((l) => ({
      product: products.find((p) => p?.id === l.product_id) ?? null,
      size: sizes.find((s) => s?.id === l.size_id) ?? null,
      qty: l.qty,
      unit_price_kes: l.unit_price_kes,
      total_kes: lineTotal(l),
      void_pending: l.status === 'void_pending',
    })),
    total_kes: orderTotal(lines),
    payments: payments.map((p) => ({ method: p.method, amount_kes: p.amount_kes, mpesa_ref_last4: p.mpesa_ref_last4 })),
    paid_kes: paidTotal(payments),
    due_kes: order.status === 'open' ? orderDue(lines, payments) : 0,
    voided: order.status === 'voided',
  };
}
