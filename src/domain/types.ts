/**
 * Data model from docs/domain-rules.md.
 *
 * Conventions: money is integer KES, volumes integer ml, counts integer units.
 * Instants are ISO-8601 UTC strings. Records are never hard-deleted.
 */

export type Id = string;
/** ISO-8601 UTC instant, e.g. "2026-11-10T18:34:00.000Z". */
export type Instant = string;
/** Business day as a calendar date, "YYYY-MM-DD" (the day it started on). */
export type BusinessDay = string;

/** Carried by every mutable business record (accountability without steps). */
export interface Recorded {
  recorded_by: Id;
  device_id: Id;
  /** Device clock at the moment it was recorded. */
  created_at: Instant;
  /** Set by the server; null while the record has only been saved on this phone. */
  synced_at: Instant | null;
}

export interface Bar {
  id: Id;
  name: string;
  timezone: string;
  /** "HH:mm" local time the business day starts. */
  day_start: string;
  self_void_minutes: number;
  ageing_minutes: number;
  pin_attempts: number;
  lockout_minutes: number;
  keg_foam_allowance_cups: number;
  /** What a counter phone types to join this bar (see domain/barCode.ts). Admins see it; on a server, phones are sent it after joining. */
  counter_code?: string;
}

export type Role = 'owner' | 'admin' | 'counter' | 'server';
export type LoginKind = 'pin' | 'password' | 'none';

export interface Person {
  id: Id;
  name: string;
  initial: string;
  colour: string;
  role: Role;
  login: LoginKind;
  /**
   * Salted hash of the PIN (counter staff, managers) or of the password
   * (owners), checked on the phone so login works offline.
   */
  pin_hash: string | null;
  /**
   * The 4-digit PIN itself, for counter staff: owners, managers and Kaunta set
   * it and can look it up (staff can't change it). Only admin stores hold it;
   * a server never sends it to counter phones.
   */
  pin_code?: string | null;
  pin_locked_until: Instant | null;
  failed_pin_attempts: number;
  archived_at: Instant | null;
  /** Access removed by an owner or manager: off the counter's list, signed out at once. Reinstating gives it back. */
  suspended_at?: Instant | null;
  /**
   * R-PIN-2: an admin's "Reset PIN" leaves a salted hash of a one-time code
   * here. The person types the code at a counter and chooses a new PIN.
   */
  pin_reset_hash?: string | null;
  pin_reset_expires_at?: Instant | null;
}

export interface Device {
  id: Id;
  name: string;
  model: string;
  paired_at: Instant;
  paired_by: Id;
  revoked_at: Instant | null;
  revoked_reason: string | null;
  last_sync_at: Instant | null;
}

export interface Category {
  id: Id;
  name_en: string;
  name_sw: string;
  sort: number;
}

export type StockMode = 'count' | 'ml';

export interface Product {
  id: Id;
  category_id: Id;
  name: string;
  name_sw: string | null;
  stock_mode: StockMode;
  /** Units or ml. Null = not tracked on the shelf (food, and kegs which use the keg queue). */
  stock_qty: number | null;
  low_stock_at: number | null;
  manual_out_of_stock: boolean;
  archived_at: Instant | null;
  /** Position on the counter within its category (best sellers first). */
  sort?: number;
  /**
   * The packs it is delivered in ("Crate of 25", "Box of 12"), set by owners
   * and managers. Missing = the usual crates of 24 and 25 (count mode) or none
   * (ml). A single bottle, and in ml mode one bottle of each size, is always offered.
   */
  packs?: Pack[] | null;
  /**
   * Each size has its own stock (250 ml and 750 ml Smirnoff counted apart).
   * `stock_qty` is then the sum of the sizes' stock. Missing = one pool.
   */
  per_size?: boolean;
}

/** A pack a product arrives in: `count` bottles or pieces (of size `size_id`, in ml mode). */
export interface Pack {
  id: Id;
  label: string;
  count: number;
  size_id?: Id | null;
}

export interface ProductSize {
  id: Id;
  product_id: Id;
  label_en: string;
  label_sw: string;
  /** Units or ml taken from stock per sale of this size. */
  deduct: number;
  price_kes: number;
  enabled: boolean;
  sort: number;
  /** Removed from the product: no longer sold or shown, kept for the orders that used it. */
  archived_at?: Instant | null;
  /**
   * Per-size stock only. This size's own stock, in units (count mode) or ml;
   * null when it has none of its own (one pool, or poured from another size).
   */
  stock_qty?: number | null;
  /** Per-size stock only: warn at or below this, in the same units as `stock_qty`. */
  low_stock_at?: number | null;
  /** Per-size stock only: sold out of another size's stock (a tot poured from the 750 ml bottle). */
  stock_from?: Id | null;
}

export type KegStatus = 'queued' | 'active' | 'finished';

export interface Keg {
  id: Id;
  product_id: Id;
  code: string;
  volume_ml: number;
  cup_ml: number;
  status: KegStatus;
  tapped_at: Instant | null;
  finished_at: Instant | null;
  finished_by: Id | null;
  /**
   * Millilitres already recorded against this keg by sales this device does
   * not hold as lines (sold before pairing, or on another counter).
   */
  recorded_ml_baseline: number;
  /** After it finished: an admin looked at the summary and wrote off cups, or none (R-KEG-3). */
  checked_at?: Instant | null;
  checked_by?: Id | null;
  written_off_cups?: number | null;
}

export type OrderStatus = 'open' | 'paid' | 'voided';

export interface Order extends Recorded {
  id: Id;
  /** "#047". Restarts each business day (R-DAY-2). */
  short_no: string;
  /** True until the server confirms the number; two offline counters may collide. */
  short_no_provisional: boolean;
  label: string;
  server_id: Id;
  business_day: BusinessDay;
  status: OrderStatus;
  /** Who took the order over at a shift change (R-ORD-6). */
  handed_over_to: Id | null;
  /** Handed over at shift close, waiting for the next person to log in on this device. */
  handover_pending?: boolean;
}

export type VoidReason = 'mistake' | 'changed' | 'size' | 'spilled' | 'other';
/**
 * `archived_product` and `revoked_device` come from the server's conflict
 * rules (R-SYNC-3): a sale of a product archived meanwhile, and an event sent
 * by a phone after it was revoked (R-DEV-2).
 */
export type ApprovalKind = 'void' | 'comp' | 'write_off' | 'price_mismatch' | 'archived_product' | 'revoked_device' | 'expense';
/** `cancelled`: taken back by the counter before anyone decided (a void request paid instead, an expense removed). */
export type ApprovalStatus = 'waiting' | 'approved' | 'rejected' | 'cancelled';

/**
 * What an approval is about. Voids name lines on an order. A breakage
 * reported at the counter, or a drink given on the house, names a product
 * and quantity instead (`item`), with the order it came up on if any.
 */
export interface ApprovalTarget {
  order_id: Id | null;
  line_ids: Id[];
  whole_order: boolean;
  item?: { product_id: Id; size_id: Id; qty: number };
  /** revoked_device: the quarantined event. */
  event_id?: Id;
  /** expense: the shift and the expense in it. */
  shift_id?: Id;
  expense_id?: Id;
}

export interface ApprovalItem {
  id: Id;
  kind: ApprovalKind;
  target: ApprovalTarget;
  /** price_mismatch: (server − recorded) × qty, so a positive amount is money short. */
  amount_kes: number;
  reason_code: VoidReason | string;
  requested_by: Id;
  device_id: Id | null;
  requested_at: Instant;
  status: ApprovalStatus;
  decided_by: Id | null;
  decided_at: Instant | null;
  /** Words staff typed, e.g. "duplicate of #042". */
  note?: string | null;
  /** What the server worked out, e.g. the two prices of a price mismatch. */
  detail?: Record<string, unknown> | null;
}

/** Where the money for an expense came from: the counter's cash drawer, or the bar's M-Pesa till. */
export type ExpenseSource = 'cash' | 'mpesa';

export interface ShiftExpense {
  /** Set for expenses recorded at the counter (the sample data's have none). */
  id?: Id;
  label: string;
  amount_kes: number;
  /** Missing on older records: those were paid from the cash drawer. */
  paid_from?: ExpenseSource;
  at?: Instant;
}

export interface Shift {
  id: Id;
  person_id: Id;
  device_id: Id;
  opened_at: Instant;
  float_kes: number;
  expenses: ShiftExpense[];
  closed_at: Instant | null;
  counted_cash_kes: number | null;
  /** counted − expected, fixed at close. */
  result_kes: number | null;
  /**
   * Cash and M-Pesa taken in this shift that this phone does not hold as
   * payment records (the sample data states them as totals). Zero for shifts
   * opened on this phone.
   */
  cash_baseline_kes: number;
  mpesa_baseline_kes: number;
}

export type LineStatus = 'active' | 'void_pending' | 'voided';

export interface OrderLine extends Recorded {
  id: Id;
  order_id: Id;
  product_id: Id;
  size_id: Id;
  qty: number;
  /** Price at the time of sale on the device (R-SELL-5). */
  unit_price_kes: number;
  status: LineStatus;
  keg_id: Id | null;
}

export type PaymentMethod = 'cash' | 'mpesa';

export interface Payment extends Recorded {
  id: Id;
  order_id: Id;
  method: PaymentMethod;
  amount_kes: number;
  mpesa_ref_last4: string | null;
}

export interface DeliveryLine {
  product_id: Id;
  /** Per-size stock: the size whose stock it went into. */
  size_id?: Id | null;
  /** How it arrived, in words: "Crate of 25", "Bottle 750 ml", "Keg 50 L". */
  container_label: string;
  container_qty: number;
  /** Units or ml in one container. */
  per_container: number;
  /** R-STOCK-2: container_qty × per_container. */
  total: number;
}

export interface Delivery {
  id: Id;
  supplier: string | null;
  note_no: string | null;
  received_by: Id;
  created_at: Instant;
  lines: DeliveryLine[];
  /** Kegs this delivery put in the queue (R-STOCK-4). */
  keg_ids: Id[];
}

/** R-DAY-3: the admin closes a business day with the till total from the M-Pesa statement. */
export interface DayClose {
  business_day: BusinessDay;
  till_total_kes: number;
  recorded_mpesa_kes: number;
  closed_by: Id;
  closed_at: Instant;
}

/**
 * R-AUD-1: append-only. `kind` is the event type (a counter's `order_recorded`,
 * an admin's `approval_decided`, `device_paired` …); `detail` is what the
 * screen needs to say it in either language, including before → after.
 */
export interface AuditEvent {
  id: Id;
  /** When it happened, on the clock of the device that recorded it. */
  at: Instant;
  actor_id: Id;
  device_id: Id | null;
  kind: string;
  ref_id: Id | null;
  detail: Record<string, unknown>;
  /** When the server got it; later than `at` when it was saved offline first. */
  synced_at: Instant | null;
}

export type StockReason = 'sale' | 'void_return' | 'write_off' | 'delivery' | 'count' | 'keg_tap';

export interface StockMovement {
  id: Id;
  product_id: Id;
  /** Per-size stock: the size whose stock moved. */
  size_id?: Id | null;
  /** Units or ml; negative for sales. */
  delta: number;
  reason: StockReason;
  ref_id: Id;
  recorded_by: Id;
  created_at: Instant;
}
