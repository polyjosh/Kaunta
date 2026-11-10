import raw from '../../kaunta-handoff/data/seed.json';
import { shiftPayments } from './shifts';
import { instantOnBusinessDay } from './time';
import type {
  Bar,
  Category,
  Device,
  Id,
  Keg,
  KegStatus,
  LoginKind,
  Order,
  OrderLine,
  Payment,
  PaymentMethod,
  Person,
  Product,
  ProductSize,
  Role,
  Shift,
  StockMode,
} from './types';

export interface SeedData {
  bar: Bar;
  categories: Category[];
  people: Person[];
  devices: Device[];
  products: Product[];
  sizes: ProductSize[];
  kegs: Keg[];
  orders: Order[];
  lines: OrderLine[];
  payments: Payment[];
  shifts: Shift[];
  /**
   * Demo PINs by person id, kept out of the Person records. Login (build
   * step 3) hashes these; nothing stores a PIN in the clear.
   */
  demoPins: Record<Id, string>;
}

export const rawSeed = raw;

/** "#041" → "041", for readable, stable seed ids. */
const idPart = (shortNo: string) => shortNo.replace('#', '');

/**
 * Turns the handoff sample data (Baraka Pub, business day 10 Nov 2026) into
 * model records: products split from their sizes, open orders split into
 * order / lines / payments, local times turned into UTC instants.
 *
 * The seed's day-level aggregates (today_summary, approvals, day_close)
 * describe sales that are not in the file as orders, so they are not loaded
 * here. Shifts are loaded, with their takings kept as stated totals. `rawSeed` exposes them for tests and later build steps.
 */
export function loadSeed(): SeedData {
  const bar: Bar = {
    id: raw.bar.id,
    name: raw.bar.name,
    timezone: raw.bar.timezone,
    day_start: raw.bar.day_start,
    self_void_minutes: raw.bar.self_void_minutes,
    ageing_minutes: raw.bar.ageing_minutes,
    pin_attempts: raw.bar.pin_attempts,
    lockout_minutes: raw.bar.lockout_minutes,
    keg_foam_allowance_cups: raw.bar.keg_foam_allowance_cups,
  };

  const demoPins: Record<Id, string> = {};
  const people: Person[] = raw.people.map((p) => {
    if ('demo_pin' in p && p.demo_pin) demoPins[p.id] = p.demo_pin;
    return {
      id: p.id,
      name: p.name,
      initial: p.initial,
      colour: p.colour,
      role: p.role as Role,
      login: p.login as LoginKind,
      pin_hash: null,
      pin_locked_until: ('pin_locked_until' in p && p.pin_locked_until) || null,
      failed_pin_attempts: 0,
      archived_at: null,
    };
  });

  const devices: Device[] = raw.devices.map((d) => ({
    id: d.id,
    name: d.name,
    model: d.model,
    paired_at: d.paired_at,
    paired_by: d.paired_by,
    revoked_at: d.revoked_at,
    revoked_reason: ('revoked_reason' in d && d.revoked_reason) || null,
    last_sync_at: null,
  }));

  const products: Product[] = [];
  const sizes: ProductSize[] = [];
  for (const [sort, p] of raw.products.entries()) {
    products.push({
      sort,
      id: p.id,
      category_id: p.category_id,
      name: p.name,
      name_sw: p.name_sw,
      stock_mode: p.stock_mode as StockMode,
      stock_qty: p.stock_qty,
      low_stock_at: p.low_stock_at,
      manual_out_of_stock: p.manual_out_of_stock,
      archived_at: null,
    });
    for (const s of p.sizes) sizes.push({ ...s, product_id: p.id });
  }
  const productOfSize = new Map(sizes.map((s) => [s.id, s.product_id]));

  const kegs: Keg[] = raw.kegs.map((k) => {
    const sold = 'recorded_since_tap' in k && k.recorded_since_tap
      ? [k.recorded_since_tap]
      : 'recorded_by_server' in k && k.recorded_by_server
        ? Object.values(k.recorded_by_server)
        : [];
    const mug = sizes.find((s) => s.product_id === k.product_id && s.deduct === k.cup_ml);
    const jug = sizes.find((s) => s.product_id === k.product_id && s.deduct !== k.cup_ml);
    const recorded_ml_baseline = sold.reduce(
      (ml, row) => ml + row.mugs * (mug?.deduct ?? k.cup_ml) + row.jugs * (jug?.deduct ?? 0),
      0,
    );
    return {
      id: k.id,
      product_id: k.product_id,
      code: k.code,
      volume_ml: k.volume_ml,
      cup_ml: k.cup_ml,
      status: k.status as KegStatus,
      tapped_at: ('tapped_at' in k && k.tapped_at) || null,
      finished_at: ('finished_at' in k && k.finished_at) || null,
      finished_by: ('finished_by' in k && k.finished_by) || null,
      recorded_ml_baseline,
    };
  });

  const orders: Order[] = [];
  const lines: OrderLine[] = [];
  const payments: Payment[] = [];
  for (const o of raw.open_orders) {
    const id = `o_${idPart(o.short_no)}`;
    const created_at = instantOnBusinessDay(o.business_day, o.created_at_local, bar.day_start);
    orders.push({
      id,
      short_no: o.short_no,
      short_no_provisional: false,
      label: o.label,
      server_id: o.server_id,
      recorded_by: o.recorded_by,
      device_id: o.device_id,
      business_day: o.business_day,
      status: 'open',
      created_at,
      synced_at: created_at,
      handed_over_to: null,
    });
    o.lines.forEach((l, i) => {
      const product_id = productOfSize.get(l.size_id);
      if (!product_id) throw new Error(`Seed order ${o.short_no} uses unknown size ${l.size_id}`);
      lines.push({
        id: `${id}_l${i}`,
        order_id: id,
        product_id,
        size_id: l.size_id,
        qty: l.qty,
        unit_price_kes: l.unit_price_kes,
        status: 'active',
        keg_id: null,
        recorded_by: o.recorded_by,
        device_id: o.device_id,
        created_at,
        synced_at: created_at,
      });
    });
    o.payments.forEach((p, i) => {
      const paidAt = instantOnBusinessDay(o.business_day, p.at_local, bar.day_start);
      payments.push({
        id: `${id}_p${i}`,
        order_id: id,
        method: p.method as PaymentMethod,
        amount_kes: p.amount_kes,
        mpesa_ref_last4: p.mpesa_ref_last4,
        recorded_by: p.recorded_by,
        device_id: o.device_id,
        created_at: paidAt,
        synced_at: paidAt,
      });
    });
  }

  // The counter screens are a snapshot at 22:20 (see the seed's _note): a shift
  // is closed only if it closed before then. Wanjiku's, which the admin
  // snapshot shows closed at 02:14, is still open at the counter, with the
  // numbers the shift-count design shows.
  const day = raw.day_close.business_day;
  const snapshot = instantOnBusinessDay(day, '22:20', bar.day_start);
  const shifts: Shift[] = raw.shifts.map((s) => {
    const opened_at = instantOnBusinessDay(day, s.opened_local, bar.day_start);
    const closedAt = s.closed_local ? instantOnBusinessDay(day, s.closed_local, bar.day_start) : null;
    const closed = closedAt !== null && closedAt <= snapshot;
    const window = { person_id: s.person_id, device_id: s.device_id, opened_at, closed_at: closed ? closedAt : null };
    const heldCash = shiftPayments(window, payments).reduce((sum, p) => (p.method === 'cash' ? sum + p.amount_kes : sum), 0);
    return {
      ...window,
      id: `s_${s.person_id}`,
      float_kes: s.float_kes,
      expenses: s.expenses,
      counted_cash_kes: closed ? s.counted_kes : null,
      result_kes: closed ? s.result_kes : null,
      // The file gives shift takings as totals; what is not held as payment rows is the baseline.
      cash_baseline_kes: s.cash_sales_kes - heldCash,
      mpesa_baseline_kes: ('mpesa_recorded_kes' in s && s.mpesa_recorded_kes) || 0,
    };
  });

  return { bar, categories: raw.categories, people, devices, products, sizes, kegs, orders, lines, payments, shifts, demoPins };
}
