/**
 * What the admin screens show, computed from records (pure functions; the
 * screens only format). Rule ids refer to docs/domain-rules.md.
 */
import { kegFinishSummary, kegRecordedMl } from './kegs';
import { lineTotal, orderDue, orderTotal, paidTotal } from './orders';
import { expectedCash, expensesTotal, rejectedExpenses, shiftPayments, shiftResult, tillExpensesTotal } from './shifts';
import type { ShiftResult } from './shifts';
import { negativePools } from './stock';
import { businessDayOf, localTime } from './time';
import type {
  ApprovalItem,
  AuditEvent,
  Bar,
  BusinessDay,
  DayClose,
  Id,
  Instant,
  Keg,
  Order,
  OrderLine,
  Payment,
  Person,
  Product,
  ProductSize,
  Shift,
} from './types';

export interface DayData {
  bar: Bar;
  people: Person[];
  products: Product[];
  sizes: ProductSize[];
  kegs: Keg[];
  /** Orders of this business day. */
  orders: Order[];
  lines: OrderLine[];
  payments: Payment[];
  approvals: ApprovalItem[];
  shifts: Shift[];
  dayClose: DayClose | null;
  /**
   * Every line poured from these kegs and the orders they are on, whatever
   * day they were sold: a keg outlives a business day (R-KEG-2).
   */
  kegSales?: { lines: OrderLine[]; orders: Order[] };
}

const byOrder = <T extends { order_id: Id }>(rows: readonly T[]) => {
  const map = new Map<Id, T[]>();
  for (const row of rows) map.set(row.order_id, [...(map.get(row.order_id) ?? []), row]);
  return map;
};

/** Lines and payments that belong to these orders. */
export function forOrders<T extends { order_id: Id }>(rows: readonly T[], orders: readonly Pick<Order, 'id'>[]): T[] {
  const ids = new Set(orders.map((o) => o.id));
  return rows.filter((r) => ids.has(r.order_id));
}

// ------------------------------------------------------------------ Today

export interface TodaySummary {
  served_kes: number;
  collected_kes: number;
  /** R-DAY-4: served − collected. Never shown below zero. */
  money_at_risk_kes: number;
  open_orders: number;
  cash_kes: number;
  mpesa_kes: number;
}

/** R-DAY-4, for the orders of one business day and the payments made on them. */
export function todaySummary(data: Pick<DayData, 'orders' | 'lines' | 'payments'>): TodaySummary {
  const lines = forOrders(data.lines, data.orders);
  const payments = forOrders(data.payments, data.orders);
  const served_kes = orderTotal(lines);
  const collected_kes = paidTotal(payments);
  const sum = (m: string) => paidTotal(payments.filter((p) => p.method === m));
  return {
    served_kes,
    collected_kes,
    money_at_risk_kes: Math.max(0, served_kes - collected_kes),
    open_orders: data.orders.filter((o) => o.status === 'open').length,
    cash_kes: sum('cash'),
    mpesa_kes: sum('mpesa'),
  };
}

export interface HourBar {
  /** "22" */
  hour: string;
  amount_kes: number;
}

/** Served per Nairobi hour, from the first hour with a sale to the last, in business-day order. */
export function salesByHour(data: Pick<DayData, 'orders' | 'lines'>, dayStart = '06:00'): HourBar[] {
  const startHour = Number(dayStart.slice(0, 2));
  const buckets = new Map<number, number>();
  const lines = byOrder(data.lines);
  for (const order of data.orders) {
    const h = Number(localTime(order.created_at).slice(0, 2));
    const slot = (h - startHour + 24) % 24;
    buckets.set(slot, (buckets.get(slot) ?? 0) + orderTotal(lines.get(order.id) ?? []));
  }
  if (buckets.size === 0) return [];
  const slots = [...buckets.keys()];
  const out: HourBar[] = [];
  for (let s = Math.min(...slots); s <= Math.max(...slots); s++) {
    out.push({ hour: String((s + startHour) % 24).padStart(2, '0'), amount_kes: buckets.get(s) ?? 0 });
  }
  return out;
}

export interface ServerTotals {
  person_id: Id;
  served_kes: number;
  collected_kes: number;
  /** Money still on this server's open orders. */
  not_paid_kes: number;
  orders: number;
}

/** Sales are credited to the server; biggest first. */
export function byServer(data: Pick<DayData, 'orders' | 'lines' | 'payments'>): ServerTotals[] {
  const lines = byOrder(data.lines);
  const payments = byOrder(data.payments);
  const totals = new Map<Id, ServerTotals>();
  for (const order of data.orders) {
    const t = totals.get(order.server_id) ?? { person_id: order.server_id, served_kes: 0, collected_kes: 0, not_paid_kes: 0, orders: 0 };
    const l = lines.get(order.id) ?? [];
    const p = payments.get(order.id) ?? [];
    t.served_kes += orderTotal(l);
    t.collected_kes += paidTotal(p);
    t.not_paid_kes += order.status === 'open' ? orderDue(l, p) : 0;
    t.orders += 1;
    totals.set(order.server_id, t);
  }
  return [...totals.values()].sort((a, b) => b.served_kes - a.served_kes || a.person_id.localeCompare(b.person_id));
}

export type Flag =
  | { kind: 'negativeStock'; product_id: Id; qty: number; /** Stock per size: the size below zero. */ size_id?: Id | null }
  | { kind: 'voids'; approvals: ApprovalItem[]; amount_kes: number }
  | { kind: 'writeOffs'; approvals: ApprovalItem[]; amount_kes: number }
  | { kind: 'priceMismatch'; approvals: ApprovalItem[]; amount_kes: number }
  | { kind: 'kegShort'; keg: Keg; short_cups: number; expected_cups: number; recorded_cups: number; value_kes: number }
  | { kind: 'shiftShort'; shift: Shift; amount_kes: number };

/**
 * "Needs your attention" (R-STOCK-3, R-VOID-2, R-SELL-5, R-KEG-3, R-SHIFT-2).
 * Approvals count while they wait, whenever they were asked; kegs and shifts
 * count for the day they finished or closed in.
 */
export function attentionFlags(data: DayData, day: BusinessDay): Flag[] {
  const flags: Flag[] = [];
  for (const product of data.products) {
    if (product.archived_at !== null) continue;
    // Per size, each size's own stock (250 ml can be short while 750 ml is not).
    for (const pool of negativePools(product, data.sizes.filter((s) => s.product_id === product.id))) {
      flags.push({ kind: 'negativeStock', product_id: product.id, qty: pool.qty, size_id: pool.size?.id ?? null });
    }
  }
  const waiting = data.approvals.filter((a) => a.status === 'waiting');
  const group = (kinds: ApprovalItem['kind'][]) => waiting.filter((a) => kinds.includes(a.kind));
  const sum = (items: ApprovalItem[]) => items.reduce((s, a) => s + a.amount_kes, 0);
  const voids = group(['void']);
  if (voids.length) flags.push({ kind: 'voids', approvals: voids, amount_kes: sum(voids) });
  const writeOffs = group(['write_off']);
  if (writeOffs.length) flags.push({ kind: 'writeOffs', approvals: writeOffs, amount_kes: sum(writeOffs) });
  const mismatches = group(['price_mismatch', 'archived_product', 'revoked_device']);
  if (mismatches.length) flags.push({ kind: 'priceMismatch', approvals: mismatches, amount_kes: sum(mismatches) });

  for (const keg of data.kegs) {
    if (keg.status !== 'finished' || keg.checked_at || !keg.finished_at) continue;
    if (businessDayOf(keg.finished_at, data.bar.day_start) !== day) continue;
    const summary = kegSummary(keg, { ...data, ...(data.kegSales ?? {}) });
    if (summary.short_cups > 0) {
      flags.push({ kind: 'kegShort', keg, short_cups: summary.short_cups, expected_cups: summary.expected_cups, recorded_cups: summary.recorded_cups, value_kes: summary.short_value_kes });
    }
  }
  for (const shift of data.shifts) {
    if (shift.closed_at && shift.result_kes !== null && shift.result_kes < 0 && businessDayOf(shift.closed_at, data.bar.day_start) === day) {
      flags.push({ kind: 'shiftShort', shift, amount_kes: -shift.result_kes });
    }
  }
  return flags;
}

// ------------------------------------------------------------------- Kegs

/** The keg product's base mug (the size that pours one cup) and its price. */
export function mugSize(keg: Pick<Keg, 'product_id' | 'cup_ml'>, sizes: readonly ProductSize[]): ProductSize | undefined {
  return sizes.find((s) => s.product_id === keg.product_id && s.deduct === keg.cup_ml);
}

export interface KegServerRow {
  person_id: Id;
  mugs: number;
  jugs: number;
  cups: number;
}

export interface KegSummaryView {
  recorded_ml: number;
  remaining_ml: number;
  expected_cups: number;
  recorded_cups: number;
  short_cups: number;
  short_value_kes: number;
  mug_price_kes: number;
  by_server: KegServerRow[];
}

/** R-KEG-2 / R-KEG-3, with the per-server breakdown of what was recorded from this keg. */
export function kegSummary(keg: Keg, data: Pick<DayData, 'bar' | 'sizes'> & { lines: OrderLine[]; orders: Order[] }): KegSummaryView {
  const sizes = new Map(data.sizes.map((s) => [s.id, s]));
  const recorded_ml = kegRecordedMl(keg, data.lines, sizes);
  const mug = mugSize(keg, data.sizes);
  const summary = kegFinishSummary(keg, recorded_ml, data.bar.keg_foam_allowance_cups, mug?.price_kes ?? 0);
  const orders = new Map(data.orders.map((o) => [o.id, o]));
  const rows = new Map<Id, KegServerRow>();
  for (const line of data.lines) {
    if (line.keg_id !== keg.id || line.status === 'voided') continue;
    const size = sizes.get(line.size_id);
    if (!size) continue;
    const server = orders.get(line.order_id)?.server_id ?? line.recorded_by;
    const row = rows.get(server) ?? { person_id: server, mugs: 0, jugs: 0, cups: 0 };
    if (size.deduct === keg.cup_ml) row.mugs += line.qty;
    else row.jugs += line.qty;
    row.cups += Math.floor((line.qty * size.deduct) / keg.cup_ml);
    rows.set(server, row);
  }
  return {
    ...summary,
    recorded_ml,
    remaining_ml: Math.max(0, keg.volume_ml - recorded_ml),
    mug_price_kes: mug?.price_kes ?? 0,
    by_server: [...rows.values()].sort((a, b) => b.cups - a.cups),
  };
}

// ----------------------------------------------------------- Reconcile

export interface ShiftRecon {
  shift: Shift;
  cash_sales_kes: number;
  /** Paid out of the cash drawer (taken off the cash expected). */
  expenses_kes: number;
  /** Paid from the M-Pesa till (taken off what the till statement should show). */
  till_expenses_kes: number;
  expected_kes: number;
  /** Null while the shift is open. */
  result: ShiftResult | null;
}

/** R-SHIFT-2, per shift that opened in this business day, oldest first. */
export function shiftRecon(data: Pick<DayData, 'shifts' | 'bar'> & { payments: Payment[]; approvals?: readonly ApprovalItem[] }, day: BusinessDay): ShiftRecon[] {
  const rejected = rejectedExpenses(data.approvals ?? []);
  return data.shifts
    .filter((s) => businessDayOf(s.opened_at, data.bar.day_start) === day)
    .sort((a, b) => a.opened_at.localeCompare(b.opened_at))
    .map((shift) => {
      const mine = shiftPayments(shift, data.payments);
      const expected_kes = expectedCash(shift, mine, rejected);
      const cash_sales_kes = expected_kes - shift.float_kes + expensesTotal(shift, rejected);
      return {
        shift,
        cash_sales_kes,
        expenses_kes: expensesTotal(shift, rejected),
        till_expenses_kes: tillExpensesTotal(shift, rejected),
        expected_kes,
        result: shift.closed_at !== null && shift.counted_cash_kes !== null ? shiftResult(shift.counted_cash_kes, expected_kes) : null,
      };
    });
}

export interface MpesaRecon {
  recorded_kes: number;
  payments: number;
  with_code: number;
  /** M-Pesa payments with no code, biggest first: the ones to check first. */
  without_code: Payment[];
}

export function mpesaRecon(data: Pick<DayData, 'orders' | 'payments'>): MpesaRecon {
  const mpesa = forOrders(data.payments, data.orders).filter((p) => p.method === 'mpesa');
  const without = mpesa.filter((p) => p.mpesa_ref_last4 === null).sort((a, b) => b.amount_kes - a.amount_kes);
  return { recorded_kes: paidTotal(mpesa), payments: mpesa.length, with_code: mpesa.length - without.length, without_code: without };
}

export type MpesaVariance = { kind: 'matches'; amount_kes: 0 } | { kind: 'notOnTill' | 'notRecorded'; amount_kes: number };

/** Paid from the M-Pesa till in these shifts: the till statement shows that much less than was recorded. */
export function tillPaidOut(shifts: readonly Pick<ShiftRecon, 'till_expenses_kes'>[]): number {
  return shifts.reduce((sum, s) => sum + s.till_expenses_kes, 0);
}

/**
 * R-DAY-3: variance = expected on the till − till, where expected is what was
 * recorded less anything paid out from the till (`tillPaidOutKes`). Positive:
 * recorded but not on the till.
 */
export function mpesaVariance(recordedKes: number, tillKes: number, tillPaidOutKes = 0): MpesaVariance {
  const diff = recordedKes - tillPaidOutKes - tillKes;
  if (diff === 0) return { kind: 'matches', amount_kes: 0 };
  return { kind: diff > 0 ? 'notOnTill' : 'notRecorded', amount_kes: Math.abs(diff) };
}

/** R-DAY-3: the day can close once every shift of it is closed and the till total is in. */
export function canCloseDay(shifts: readonly ShiftRecon[], tillKes: number | null): boolean {
  return tillKes !== null && shifts.every((s) => s.shift.closed_at !== null);
}

// ------------------------------------------------------------------ Feed

export type FeedKind = 'served' | 'paid' | 'void' | 'review';

export interface FeedRow {
  id: Id;
  at: Instant;
  kind: FeedKind;
  order: Order | null;
  /** served / paid: the lines recorded; void: the lines voided. */
  lines: OrderLine[];
  payments: Payment[];
  amount_kes: number;
  approval: ApprovalItem | null;
  actor_id: Id;
  device_id: Id | null;
  /** void: done by the person themselves inside the window. */
  selfVoid?: { reason: string };
}

/**
 * The live sales feed, newest first, built from the audit log so rows arrive
 * exactly as counters sync. Approvals raised by the server (price mismatch,
 * archived product, revoked phone) come in as "needs review" too.
 */
export function feedRows(audit: readonly AuditEvent[], data: Pick<DayData, 'orders' | 'lines' | 'payments' | 'approvals'>): FeedRow[] {
  const orders = new Map(data.orders.map((o) => [o.id, o]));
  const lines = new Map(data.lines.map((l) => [l.id, l]));
  const rows: FeedRow[] = [];
  for (const e of audit) {
    const d = e.detail as Record<string, any>;
    const base = { id: e.id, at: e.at, actor_id: e.actor_id, device_id: e.device_id, approval: null };
    if (e.kind === 'order_recorded') {
      const order = orders.get(d.order?.id);
      if (!order) continue;
      const recorded: OrderLine[] = d.lines ?? [];
      const paid: Payment[] = d.payments ?? [];
      rows.push({ ...base, kind: paid.length > 0 ? 'paid' : 'served', order, lines: recorded, payments: paid, amount_kes: recorded.reduce((s, l) => s + lineTotal(l), 0) });
    } else if (e.kind === 'lines_added') {
      const order = orders.get(d.order_id);
      if (!order) continue;
      const added: OrderLine[] = d.lines ?? [];
      rows.push({ ...base, kind: 'served', order, lines: added, payments: [], amount_kes: added.reduce((s, l) => s + lineTotal(l), 0) });
    } else if (e.kind === 'payment_recorded') {
      const order = orders.get(d.order_id);
      if (!order) continue;
      const paid: Payment[] = d.payments ?? [];
      rows.push({ ...base, kind: 'paid', order, lines: [], payments: paid, amount_kes: paidTotal(paid) });
    } else if (e.kind === 'void_recorded') {
      const order = orders.get(d.order_id);
      if (!order) continue;
      const voided = (d.parts ?? []).map((p: { line_id: Id; split_line_id: Id | null; qty: number }) => {
        const line = lines.get(p.split_line_id ?? p.line_id) ?? lines.get(p.line_id);
        return line ? { ...line, qty: p.qty } : null;
      }).filter(Boolean) as OrderLine[];
      rows.push({ ...base, kind: 'void', order, lines: voided, payments: [], amount_kes: voided.reduce((s, l) => s + lineTotal(l), 0), selfVoid: { reason: d.reason } });
    } else if (e.kind === 'void_requested') {
      const approval = data.approvals.find((a) => a.id === d.approval?.id) ?? d.approval;
      if (!approval) continue;
      const order = approval.target.order_id ? orders.get(approval.target.order_id) ?? null : null;
      rows.push({ ...base, kind: 'review', order, lines: approval.target.line_ids.map((id: Id) => lines.get(id)).filter(Boolean) as OrderLine[], payments: [], amount_kes: approval.amount_kes, approval });
    }
  }
  const audited = new Set(rows.map((r) => r.approval?.id).filter(Boolean));
  for (const approval of data.approvals) {
    if (approval.requested_by !== 'system' || audited.has(approval.id)) continue;
    const order = approval.target.order_id ? orders.get(approval.target.order_id) ?? null : null;
    if (approval.target.order_id && !order) continue;
    rows.push({ id: approval.id, at: approval.requested_at, kind: 'review', order, lines: approval.target.line_ids.map((id) => lines.get(id)).filter(Boolean) as OrderLine[], payments: [], amount_kes: approval.amount_kes, approval, actor_id: 'system', device_id: approval.device_id });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

// ------------------------------------------------------------------ Audit

export type AuditGroup = 'sales' | 'payments' | 'voids' | 'products' | 'stock' | 'logins' | 'shifts';

const GROUPS: Record<AuditGroup, string[]> = {
  sales: ['order_recorded', 'lines_added', 'lines_moved', 'order_handed_over', 'handover_accepted'],
  payments: ['payment_recorded'],
  voids: ['void_recorded', 'void_requested', 'approval_decided', 'approval_undone'],
  products: ['product_saved'],
  stock: ['delivery_recorded', 'shelf_counted', 'keg_finished', 'keg_checked'],
  logins: ['login', 'logged_in', 'pin_failed', 'person_unlocked', 'pin_reset', 'pin_set', 'pin_changed', 'person_saved', 'person_archived', 'person_suspended', 'person_reinstated', 'device_paired', 'device_revoked'],
  shifts: ['shift_opened', 'shift_expense_added', 'shift_expense_removed', 'shift_closed', 'day_closed'],
};
export const AUDIT_GROUPS = Object.keys(GROUPS) as AuditGroup[];

export function auditGroup(kind: string): AuditGroup | null {
  for (const group of AUDIT_GROUPS) if (GROUPS[group].includes(kind)) return group;
  return null;
}

export interface AuditFilter {
  day?: BusinessDay;
  person?: Id;
  device?: Id;
  groups?: AuditGroup[];
  /** Free text: order number, product name, M-Pesa last 4 (R-AUD-2). */
  text?: string;
}

/** Words an audit row can be found by, beyond its summary. */
export function auditSearchText(e: AuditEvent): string {
  return JSON.stringify(e.detail).toLowerCase();
}

/** R-AUD-2, newest first. `dayStart` places each row in its business day. */
export function filterAudit(rows: readonly AuditEvent[], filter: AuditFilter, dayStart: string, describe: (e: AuditEvent) => string): AuditEvent[] {
  const text = filter.text?.trim().toLowerCase();
  return rows
    .filter((e) => !filter.day || businessDayOf(e.at, dayStart) === filter.day)
    .filter((e) => !filter.person || e.actor_id === filter.person)
    .filter((e) => !filter.device || e.device_id === filter.device)
    .filter((e) => !filter.groups?.length || filter.groups.includes(auditGroup(e.kind) as AuditGroup))
    .filter((e) => !text || describe(e).toLowerCase().includes(text) || auditSearchText(e).includes(text))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

/** RFC 4180 CSV: every field quoted, quotes doubled. */
export function toCsv(rows: readonly (readonly (string | number | null)[])[]): string {
  return rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
}
