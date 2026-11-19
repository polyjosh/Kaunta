import { uuidv7 } from '../domain/ids';
import type {
  ApprovalItem,
  AuditEvent,
  DayClose,
  Delivery,
  Id,
  Instant,
  Keg,
  Person,
  Product,
  ProductSize,
  StockReason,
} from '../domain/types';
import type { KauntaDB } from './db';
import { refreshOrderStatus } from './events';
import { shiftStock } from './pools';
import { isPerSize, rebalancePools } from '../domain/stock';
import type { OutboxStatus } from './events';

export type Decision = 'approved' | 'rejected';

/** Undo is offered for this long after a decision; after that it is final (Approvals). */
export const UNDO_GRACE_MS = 2 * 60_000;

/**
 * What an admin can change. Like counter events, each carries complete
 * records decided on the admin's screen, so the server stores the decision
 * rather than re-deciding it.
 */
export type AdminEvent =
  /** R-VOID-2…4, R-COMP-1, R-SELL-5, R-SYNC-3. */
  | { type: 'approval_decided'; payload: { approval_id: Id; decision: Decision; decided_at: Instant } }
  /** Inside UNDO_GRACE_MS only: the item goes back to waiting and its effect is reversed. */
  | { type: 'approval_undone'; payload: { approval_id: Id } }
  /** Product editor. `before` is what it was, for the audit log's before → after; null for a new product. */
  | {
      type: 'product_saved';
      payload: { product: Product; sizes: ProductSize[]; before: { product: Product; sizes: ProductSize[] } | null };
    }
  /** R-STOCK-2 / R-STOCK-4: containers converted to units or ml; kegs go to the queue. */
  | { type: 'delivery_recorded'; payload: { delivery: Delivery; kegs: Keg[] } }
  /** Count shelf: the shelf is what it is; the difference is a `count` movement. */
  | { type: 'shelf_counted'; payload: { product_id: Id; counted_qty: number; before_qty: number; size_id?: Id | null } }
  /** R-KEG-1: finished, and the next queued keg goes on tap. */
  | { type: 'keg_finished'; payload: { keg_id: Id; finished_at: Instant; next_keg_id: Id | null } }
  /** R-KEG-3: the admin looked at the summary and wrote off the missing cups, or none. */
  | { type: 'keg_checked'; payload: { keg_id: Id; write_off_cups: number; value_kes: number } }
  /** R-PIN-1 / R-PIN-2 */
  | { type: 'person_unlocked'; payload: { person_id: Id } }
  | { type: 'pin_reset'; payload: { person_id: Id; reset_hash: string; expires_at: Instant } }
  | { type: 'person_saved'; payload: { person: Person } }
  | { type: 'person_archived'; payload: { person_id: Id } }
  /**
   * An owner, manager or Kaunta sets a counter person's 4-digit PIN (staff
   * can't change their own). The PIN goes with the hash so admins can look it
   * up; the audit row keeps neither.
   */
  | { type: 'pin_changed'; payload: { person_id: Id; pin_hash: string; pin_code: string } }
  /** Access removed: off the counter's list and signed out at once; what they recorded stays. */
  | { type: 'person_suspended'; payload: { person_id: Id } }
  | { type: 'person_reinstated'; payload: { person_id: Id } }
  /** R-DEV-2 */
  | { type: 'device_revoked'; payload: { device_id: Id; reason: string } }
  /** R-DAY-3: kept on record with whatever variance there was. */
  | { type: 'day_closed'; payload: { day_close: DayClose } };

export type AdminEventType = AdminEvent['type'];

export type AdminOutboxEntry = AdminEvent & {
  seq?: number;
  id: Id;
  recorded_by: Id;
  device_id: Id;
  created_at: Instant;
  status: OutboxStatus;
  synced_at: Instant | null;
  attempts: number;
  review_reason: string | null;
  review_detail?: Record<string, unknown> | null;
};

/** The admin's browser is not a counter device; its records say so. */
export const ADMIN_DEVICE = 'admin';

/** Who a change made on the Kaunta platform (/super) is recorded as. */
export const KAUNTA_ACTOR = 'kaunta';

export interface AdminContext {
  person_id: Id;
  now?: () => Date;
}

/**
 * The only way the admin writes. In one transaction: apply to the local
 * store, add an audit row (R-AUD-1), append to the admin outbox.
 */
export async function recordAdminEvent(db: KauntaDB, ctx: AdminContext, event: AdminEvent): Promise<AdminOutboxEntry> {
  const at = ctx.now?.() ?? new Date();
  const entry: AdminOutboxEntry = {
    ...event,
    id: uuidv7(at.getTime()),
    recorded_by: ctx.person_id,
    device_id: ADMIN_DEVICE,
    created_at: at.toISOString(),
    status: 'pending',
    synced_at: null,
    attempts: 0,
    review_reason: null,
  };
  await db.transaction('rw', db.tables, async () => {
    await applyAdminEvent(db, event, { by: ctx.person_id, at: entry.created_at });
    const audit: AuditEvent = {
      id: entry.id,
      at: entry.created_at,
      actor_id: ctx.person_id,
      device_id: ADMIN_DEVICE,
      kind: event.type,
      ref_id: refOf(event),
      detail: auditDetail(event),
      synced_at: null,
    };
    await db.auditEvents.add(audit);
    entry.seq = await db.adminOutbox.add(entry);
  });
  return entry;
}

/** What the audit log keeps of an event: everything but PINs and their hashes. */
export function auditDetail(event: AdminEvent): Record<string, unknown> {
  const { pin_hash: _hash, pin_code: _code, reset_hash: _reset, ...rest } = event.payload as unknown as Record<string, unknown>;
  return rest;
}

export function refOf(event: AdminEvent): Id | null {
  const p = event.payload as Record<string, unknown>;
  for (const key of ['approval_id', 'product_id', 'keg_id', 'person_id', 'device_id']) {
    if (typeof p[key] === 'string') return p[key] as Id;
  }
  if (event.type === 'product_saved') return event.payload.product.id;
  if (event.type === 'delivery_recorded') return event.payload.delivery.id;
  if (event.type === 'person_saved') return event.payload.person.id;
  if (event.type === 'day_closed') return event.payload.day_close.business_day;
  return null;
}

interface StockChange {
  product_id: Id;
  /** The size sold or written off: per-size stock moves that size's stock (or the one it is poured from). */
  size_id?: Id | null;
  delta: number;
  reason: StockReason;
}

export interface ApprovalEffect {
  /** New status for the target lines, or null to leave them. */
  lines: 'voided' | 'active' | null;
  stock: StockChange[];
}

/**
 * What a decision does (R-VOID-2…4, R-COMP-1). Pure, so the effect sentence
 * on the card and the effect itself come from the same place, and undo is
 * the exact reverse.
 */
export function approvalEffect(
  approval: Pick<ApprovalItem, 'kind' | 'target'>,
  decision: Decision,
  lineStock: readonly StockChange[],
  /** Units or ml one of `target.item`'s size takes from stock. */
  itemDeduct = 1,
): ApprovalEffect {
  const item = approval.target.item;
  const itemStock = (sign: 1 | -1, reason: StockReason): StockChange[] =>
    item ? [{ product_id: item.product_id, size_id: item.size_id, delta: sign * item.qty * itemDeduct, reason }] : [];
  switch (approval.kind) {
    case 'void':
      // Approved: the lines go and their stock comes back. Rejected: they stand.
      return decision === 'approved' ? { lines: 'voided', stock: [...lineStock] } : { lines: 'active', stock: [] };
    case 'write_off':
      // Line write-offs: voided, stock not returned (R-VOID-3). Reported breakage
      // was taken off the shelf when reported; rejecting puts it back to be found.
      if (item) return { lines: null, stock: decision === 'approved' ? [] : itemStock(1, 'write_off') };
      return { lines: decision === 'approved' ? 'voided' : 'active', stock: [] };
    case 'comp':
      if (item) return { lines: null, stock: decision === 'approved' ? itemStock(-1, 'write_off') : [] };
      return { lines: decision === 'approved' ? 'voided' : 'active', stock: [] };
    case 'archived_product':
      return decision === 'approved' ? { lines: null, stock: [] } : { lines: 'voided', stock: [...lineStock] };
    case 'price_mismatch':
    case 'revoked_device':
    case 'expense':
      // An expense changes no stock; rejecting it takes it off what the shift's cash expects (rejectedExpenses).
      return { lines: null, stock: [] };
  }
}

/** Stock each target line would put back if voided, in units or ml (R-VOID-4). */
async function itemDeduct(db: KauntaDB, approval: ApprovalItem): Promise<number> {
  const item = approval.target.item;
  return item ? ((await db.sizes.get(item.size_id))?.deduct ?? 1) : 1;
}

async function lineReturns(db: KauntaDB, approval: ApprovalItem): Promise<StockChange[]> {
  const changes: StockChange[] = [];
  for (const line of await db.lines.bulkGet(approval.target.line_ids)) {
    if (!line) continue;
    const size = await db.sizes.get(line.size_id);
    if (size) changes.push({ product_id: line.product_id, size_id: size.id, delta: size.deduct * line.qty, reason: 'void_return' });
  }
  return changes;
}

async function moveStock(db: KauntaDB, change: StockChange, ref: Id, by: Id, at: Instant, key: string): Promise<void> {
  if (change.delta === 0) return;
  const pool = await shiftStock(db, change.product_id, change.size_id, change.delta);
  if (pool === undefined) return;
  await db.stockMovements.put({ id: `${ref}:${key}`, product_id: change.product_id, size_id: pool, delta: change.delta, reason: change.reason, ref_id: ref, recorded_by: by, created_at: at });
}

async function applyEffect(db: KauntaDB, approval: ApprovalItem, effect: ApprovalEffect, by: Id, at: Instant, key: string, linesTo: 'voided' | 'active' | 'void_pending' | null) {
  if (linesTo) {
    await db.lines.where('id').anyOf(approval.target.line_ids).modify({ status: linesTo });
    if (approval.target.order_id) await refreshOrderStatus(db, approval.target.order_id);
  }
  for (const [i, change] of effect.stock.entries()) await moveStock(db, change, approval.id, by, at, `${key}${i}`);
}

/** Applies an admin event to the local store. Runs inside recordAdminEvent's transaction. */
export async function applyAdminEvent(db: KauntaDB, event: AdminEvent, { by, at }: { by: Id; at: Instant }): Promise<void> {
  switch (event.type) {
    case 'approval_decided': {
      const { approval_id, decision, decided_at } = event.payload;
      const approval = await db.approvals.get(approval_id);
      if (!approval) throw new Error(`No such approval: ${approval_id}`);
      if (approval.status !== 'waiting') throw new Error('Already decided');
      const effect = approvalEffect(approval, decision, await lineReturns(db, approval), await itemDeduct(db, approval));
      await applyEffect(db, approval, effect, by, decided_at, decision, effect.lines);
      await db.approvals.update(approval_id, { status: decision, decided_by: by, decided_at });
      return;
    }
    case 'approval_undone': {
      const approval = await db.approvals.get(event.payload.approval_id);
      if (!approval || approval.status === 'waiting' || approval.status === 'cancelled' || !approval.decided_at) throw new Error('Nothing to undo');
      if (Date.parse(at) - Date.parse(approval.decided_at) > UNDO_GRACE_MS) throw new Error('Too late to undo: the decision is final');
      const decision = approval.status;
      const effect = approvalEffect(approval, decision, await lineReturns(db, approval), await itemDeduct(db, approval));
      const reverse = { lines: effect.lines, stock: effect.stock.map((s) => ({ ...s, delta: -s.delta })) };
      // Lines go back to how they waited: void requests wait as void_pending; a sale of an archived product stood as recorded.
      const waitedAs = approval.kind === 'archived_product' ? 'active' : 'void_pending';
      await applyEffect(db, approval, reverse, by, at, `undo:${decision}:${at}:`, effect.lines ? waitedAs : null);
      await db.approvals.update(approval.id, { status: 'waiting', decided_by: null, decided_at: null });
      return;
    }
    case 'product_saved': {
      const { product, sizes } = event.payload;
      // Stock stays as it is on this device (sales may have come in since the editor opened); only how it is split by size follows the save.
      const was = await db.products.get(product.id);
      const previous = await db.sizes.where('product_id').equals(product.id).toArray();
      const saved = { ...product, stock_qty: was ? was.stock_qty : product.stock_qty };
      await db.products.put(saved);
      await db.sizes.bulkPut(rebalancePools(saved, was ? isPerSize(was) : false, sizes, previous));
      return;
    }
    case 'delivery_recorded': {
      const { delivery, kegs } = event.payload;
      await db.deliveries.add(delivery);
      for (const [i, line] of delivery.lines.entries()) {
        await moveStock(db, { product_id: line.product_id, size_id: line.size_id ?? null, delta: line.total, reason: 'delivery' }, delivery.id, by, at, `delivery${i}`);
      }
      if (kegs.length > 0) await db.kegs.bulkAdd(kegs);
      return;
    }
    case 'shelf_counted': {
      const { product_id, counted_qty, size_id } = event.payload;
      const product = await db.products.get(product_id);
      if (!product || product.stock_qty === null) throw new Error('This product is not counted on the shelf');
      // Per-size stock: one size is counted, against that size's stock.
      const pool = size_id && isPerSize(product) ? await db.sizes.get(size_id) : undefined;
      if (size_id && isPerSize(product) && (!pool || pool.stock_from)) throw new Error('That size has no stock of its own');
      const before = pool ? (pool.stock_qty ?? 0) : product.stock_qty;
      await moveStock(db, { product_id, size_id: pool?.id ?? null, delta: counted_qty - before, reason: 'count' }, product_id, by, at, `count:${size_id ? `${size_id}:` : ''}${at}`);
      return;
    }
    case 'keg_finished': {
      const { keg_id, finished_at, next_keg_id } = event.payload;
      await db.kegs.update(keg_id, { status: 'finished', finished_at, finished_by: by });
      if (next_keg_id) await db.kegs.update(next_keg_id, { status: 'active', tapped_at: finished_at });
      return;
    }
    case 'keg_checked': {
      const { keg_id, write_off_cups } = event.payload;
      await db.kegs.update(keg_id, { checked_at: at, checked_by: by, written_off_cups: write_off_cups });
      return;
    }
    case 'person_unlocked': {
      await db.people.update(event.payload.person_id, { pin_locked_until: null, failed_pin_attempts: 0 });
      return;
    }
    case 'pin_reset': {
      const { person_id, reset_hash, expires_at } = event.payload;
      await db.people.update(person_id, { pin_reset_hash: reset_hash, pin_reset_expires_at: expires_at, pin_locked_until: null, failed_pin_attempts: 0 });
      return;
    }
    case 'person_saved': {
      await db.people.put(event.payload.person);
      return;
    }
    case 'person_archived': {
      await db.people.update(event.payload.person_id, { archived_at: at });
      return;
    }
    case 'pin_changed': {
      const { person_id, pin_hash, pin_code } = event.payload;
      await db.people.update(person_id, { pin_hash, pin_code, pin_reset_hash: null, pin_reset_expires_at: null, pin_locked_until: null, failed_pin_attempts: 0 });
      return;
    }
    case 'person_suspended': {
      await db.people.update(event.payload.person_id, { suspended_at: at });
      return;
    }
    case 'person_reinstated': {
      await db.people.update(event.payload.person_id, { suspended_at: null });
      return;
    }
    case 'device_revoked': {
      await db.devices.update(event.payload.device_id, { revoked_at: at, revoked_reason: event.payload.reason });
      return;
    }
    case 'day_closed': {
      await db.dayCloses.put(event.payload.day_close);
      return;
    }
  }
}
