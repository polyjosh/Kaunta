import { loadSeed, rawSeed } from './seed';
import type { SeedData } from './seed';
import { instantOnBusinessDay, localTime } from './time';
import type {
  ApprovalItem,
  AuditEvent,
  Delivery,
  Id,
  Instant,
  Order,
  OrderLine,
  Payment,
  PaymentMethod,
  ProductSize,
  Shift,
  StockMovement,
} from './types';

/**
 * The admin's sample: the whole of Baraka Pub's business day, Tue 10 Nov
 * 2026, as it stands at 02:14 on Wednesday (the seed's "now" for admin
 * screens).
 *
 * The handoff seed gives the day as totals (served 86,450, collected 79,970,
 * cash 31,570, M-Pesa 48,400, by server, by hour, per shift). The admin
 * screens compute everything from records, so this builds orders, lines and
 * payments that add up to exactly those totals, around the five open orders
 * and the five approvals the seed spells out. It is deterministic: the same
 * records every time. `sampleDay.test.ts` checks every total.
 *
 * Kept apart from `loadSeed()`, which is the counter's snapshot at 22:20 with
 * shift takings held as totals.
 */

export const SAMPLE_DAY = '2026-11-10';
/** 02:14 on Wednesday 11 Nov, Nairobi. */
export const SAMPLE_NOW: Instant = '2026-11-10T23:14:00.000Z';

export interface SampleDay extends SeedData {
  approvals: ApprovalItem[];
  deliveries: Delivery[];
  stockMovements: StockMovement[];
  auditEvents: AuditEvent[];
}

const at = (local: string, day = SAMPLE_DAY): Instant => instantOnBusinessDay(day, local, '06:00');
const addMinutes = (instant: Instant, minutes: number): Instant =>
  new Date(Date.parse(instant) + minutes * 60_000).toISOString();

/** mulberry32: a tiny seeded PRNG, so the sample is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Business-day hours in order, as the seed labels them. */
const HOURS = ['16', '17', '18', '19', '20', '21', '22', '23', '00', '01', '02'] as const;
type Hour = (typeof HOURS)[number];
const hourIndex = (instant: Instant) => HOURS.indexOf(localTime(instant).slice(0, 2) as Hour);

/** Hours (indexes into HOURS) each server worked the floor. */
const AVAILABLE: Record<Id, [number, number]> = {
  p_mwangi: [0, 3], // 16:00–20:00, his shift
  p_otieno: [0, 10],
  p_kiprop: [1, 10],
  p_wanjiku: [2, 10],
  p_akinyi: [2, 10],
};

const MIN_ORDER = 300;

/**
 * Splits each hour's sales between the servers on the floor, so every hour
 * adds up to the seed's hour total and every server to their own total.
 * Shares follow each server's remaining pace; no share is below MIN_ORDER.
 */
function allocate(hourTotals: number[], needs: Record<Id, number>): Record<Id, number>[] {
  const left = { ...needs };
  const cells: Record<Id, number>[] = [];
  HOURS.forEach((_, h) => {
    let budget = hourTotals[h]!;
    const cell: Record<Id, number> = {};
    const onFloor = Object.keys(left).filter((s) => left[s]! > 0 && AVAILABLE[s]![0] <= h && h <= AVAILABLE[s]![1]);
    const last = h === HOURS.length - 1;
    // Whoever leaves after this hour takes the rest of their total now.
    for (const s of onFloor.filter((s) => AVAILABLE[s]![1] === h || last)) {
      cell[s] = left[s]!;
      budget -= left[s]!;
    }
    const rest = onFloor.filter((s) => cell[s] === undefined);
    if (rest.length > 0) {
      const pace = rest.map((s) => left[s]! / (AVAILABLE[s]![1] - h + 1));
      const sum = pace.reduce((a, b) => a + b, 0);
      const shares = pace.map((p) => Math.floor((budget * p) / sum / 10) * 10);
      shares[shares.indexOf(Math.max(...shares))]! += budget - shares.reduce((a, b) => a + b, 0);
      rest.forEach((s, i) => {
        let share = Math.min(shares[i]!, left[s]!);
        // Never leave a server a remainder too small to be an order.
        if (left[s]! - share > 0 && left[s]! - share < MIN_ORDER) share = Math.max(0, left[s]! - MIN_ORDER);
        if (share > 0 && share < MIN_ORDER) share = 0;
        cell[s] = share;
      });
      // Whatever rounding moved goes to whoever can take it, biggest first.
      let gap = budget - rest.reduce((a, s) => a + cell[s]!, 0);
      for (const s of [...rest].sort((a, b) => cell[b]! - cell[a]!)) {
        if (gap === 0) break;
        const room = gap > 0 ? left[s]! - cell[s]! : cell[s]!;
        let move = Math.sign(gap) * Math.min(Math.abs(gap), room);
        const after = cell[s]! + move;
        const remainder = left[s]! - after;
        if (remainder > 0 && remainder < MIN_ORDER) move -= MIN_ORDER - remainder;
        if (after > 0 && after < MIN_ORDER) continue;
        cell[s]! += move;
        gap -= move;
      }
      if (gap !== 0) throw new Error(`sample day: hour ${HOURS[h]} is ${gap} out`);
    } else if (budget !== 0) {
      throw new Error(`sample day: hour ${HOURS[h]} is ${budget} out`);
    }
    for (const s of Object.keys(cell)) {
      if (cell[s] === 0) delete cell[s];
      else left[s]! -= cell[s]!;
    }
    cells.push(cell);
  });
  const unplaced = Object.entries(left).filter(([, v]) => v !== 0);
  if (unplaced.length > 0) throw new Error(`sample day: servers left over ${JSON.stringify(unplaced)}`);
  return cells;
}

/** Fewest items making exactly `amount` from these prices, or null. */
function exactBasket(amount: number, sizes: readonly ProductSize[]): ProductSize[] | null {
  const best: (number | null)[] = Array(amount + 1).fill(null);
  const via: number[] = Array(amount + 1).fill(-1);
  best[0] = 0;
  for (let a = 10; a <= amount; a += 10) {
    sizes.forEach((size, i) => {
      const prev = a - size.price_kes;
      if (prev >= 0 && best[prev] !== null && (best[a] === null || best[prev]! + 1 < best[a]!)) {
        best[a] = best[prev]! + 1;
        via[a] = i;
      }
    });
  }
  if (best[amount] === null) return null;
  const out: ProductSize[] = [];
  for (let a = amount; a > 0; a -= sizes[via[a]!]!.price_kes) out.push(sizes[via[a]!]!);
  return out;
}

interface Draft {
  created_at: Instant;
  server_id: Id;
  amount: number;
  short_no?: string;
  label?: string;
  /** Fixed lines (size id, qty), priced from the menu. The rest is composed. */
  fixed?: [Id, number][];
  device_id?: Id;
  recorded_by?: Id;
}

export function loadSampleDay(): SampleDay {
  const base = loadSeed();
  const random = prng(20261110);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const sizeById = new Map(base.sizes.map((s) => [s.id, s]));
  const productOf = (sizeId: Id) => sizeById.get(sizeId)!.product_id;
  const mug = sizeById.get('keg_0')!;
  const jug = sizeById.get('keg_1')!;

  // What the counter can sell, weighted the way a bar sells: mostly beer.
  const sellable = base.products.filter((p) => !p.manual_out_of_stock && p.category_id !== 'keg');
  const weight: Record<string, number> = { beer: 6, spirits: 3, soft: 2, food: 2 };
  const menu: ProductSize[] = [];
  for (const product of sellable) {
    for (const size of base.sizes.filter((s) => s.product_id === product.id && s.enabled)) {
      for (let i = 0; i < (weight[product.category_id] ?? 1); i++) menu.push(size);
    }
  }
  const coins = [...new Map(menu.map((s) => [s.price_kes, s])).values()];

  function compose(amount: number, fixed: [Id, number][] = []): [Id, number][] {
    const items: ProductSize[] = fixed.flatMap(([id, qty]) => Array(qty).fill(sizeById.get(id)!));
    let rem = amount - items.reduce((sum, s) => sum + s.price_kes, 0);
    const picked: ProductSize[] = [];
    while (rem > 700) {
      const choice = pick(menu.filter((s) => s.price_kes <= rem - 150));
      picked.push(choice);
      rem -= choice.price_kes;
    }
    let tail = exactBasket(rem, coins);
    while (tail === null) {
      const back = picked.pop();
      if (!back) throw new Error(`sample day: cannot make an order of ${amount}`);
      rem += back.price_kes;
      tail = exactBasket(rem, coins);
    }
    const counts = new Map<Id, number>();
    for (const size of [...items, ...picked, ...tail]) counts.set(size.id, (counts.get(size.id) ?? 0) + 1);
    return [...counts.entries()];
  }

  // ---- what the seed pins down -------------------------------------------
  const open = base.orders;
  const openLines = base.lines;
  const servedAt = (order: Order) =>
    openLines.filter((l) => l.order_id === order.id).reduce((sum, l) => sum + l.qty * l.unit_price_kes, 0);

  const summary = rawSeed.today_summary;
  const hourTotals = HOURS.map((h) => summary.by_hour_kes[h]);
  const needs: Record<Id, number> = Object.fromEntries(
    Object.entries(summary.by_server).map(([id, s]) => [id, s.served_kes]),
  );
  for (const order of open) {
    hourTotals[hourIndex(order.created_at)]! -= servedAt(order);
    needs[order.server_id]! -= servedAt(order);
  }

  // Orders the approvals and the M-Pesa check talk about.
  const pinned: Draft[] = [
    { short_no: '#022', created_at: at('18:34'), server_id: 'p_mwangi', amount: 600, label: 'Table 3', device_id: 'd_counter2', recorded_by: 'p_mwangi' },
    { short_no: '#036', created_at: at('19:52'), server_id: 'p_kiprop', amount: 900, label: 'Table 6', fixed: [['tusker_0', 1]], device_id: 'd_counter2', recorded_by: 'p_mwangi' },
    { short_no: '#042', created_at: at('21:36'), server_id: 'p_akinyi', amount: 2300, label: 'Mzee in blue', device_id: 'd_counter2', recorded_by: 'p_akinyi',
      fixed: openLines.filter((l) => l.order_id === 'o_041').map((l) => [l.size_id, l.qty]) },
    { short_no: '#046', created_at: at('22:12'), server_id: 'p_kiprop', amount: 750, label: 'Table 7', fixed: [['cane_2', 1], ['tusker_0', 1]], device_id: 'd_counter2', recorded_by: 'p_kiprop' },
  ];
  for (const d of pinned) {
    hourTotals[hourIndex(d.created_at)]! -= d.amount;
    needs[d.server_id]! -= d.amount;
  }

  // ---- the rest of the day, hour by hour, server by server ----------------
  const drafts: Draft[] = [...pinned];
  allocate(hourTotals, needs).forEach((cell, h) => {
    for (const [server, amount] of Object.entries(cell)) {
      const n = Math.max(1, Math.min(Math.floor(amount / MIN_ORDER), Math.round(amount / 1000)));
      const each = Math.floor(amount / n / 10) * 10;
      for (let i = 0; i < n; i++) {
        const minute = Math.floor(random() * 60);
        const hourStart = at(`${HOURS[h]}:00`);
        let created = addMinutes(hourStart, minute);
        if (created >= SAMPLE_NOW) created = addMinutes(hourStart, Math.floor(random() * 13));
        drafts.push({ created_at: created, server_id: server, amount: i === n - 1 ? amount - each * (n - 1) : each });
      }
    }
  });
  drafts.sort((a, b) => a.created_at.localeCompare(b.created_at));

  // K-08 went on tap at 20:10: 30 mugs and 2 jugs recorded since (R-KEG-2).
  let mugs = rawSeed.kegs[1]!.recorded_since_tap!.mugs;
  let jugs = rawSeed.kegs[1]!.recorded_since_tap!.jugs;
  const tapped = at('20:10');
  const afterTap = drafts.filter((d) => d.created_at >= tapped && !d.fixed);
  afterTap.forEach((d, i) => {
    const fits = (value: number) => d.amount - value === 0 || d.amount - value >= 120;
    if (jugs > 0 && i % 17 === 5 && fits(jug.price_kes)) {
      d.fixed = [['keg_1', 1]];
      jugs--;
    } else if (mugs > 0 && i % 2 === 0) {
      const n = mugs >= 2 && fits(2 * mug.price_kes) && random() < 0.4 ? 2 : 1;
      if (fits(n * mug.price_kes)) {
        d.fixed = [['keg_0', n]];
        mugs -= n;
      }
    }
  });
  if (mugs !== 0 || jugs !== 0) throw new Error(`sample day: keg K-08 left ${mugs} mugs, ${jugs} jugs`);

  // ---- who recorded it, on which phone -------------------------------------
  // Counter 2: Mwangi until 20:00, then Akinyi. Counter 1: Otieno until 18:00
  // (no shift, so M-Pesa only), then Wanjiku. Otieno and Kiprop also take the
  // odd M-Pesa payment. Wanjiku's takings must come to her shift's 29,950
  // (30,350 less the 400 on open order #044).
  const wanjikuTarget = rawSeed.shifts[1]!.cash_sales_kes + rawSeed.shifts[1]!.mpesa_recorded_kes! - 400;
  const evening = drafts.filter((d) => d.created_at >= at('18:00') && !d.recorded_by);
  const eveningTotal = evening.reduce((s, d) => s + d.amount, 0);
  let seen = 0;
  let wanjiku = 0;
  drafts.forEach((d, i) => {
    if (d.recorded_by) return;
    if (d.created_at < at('18:00')) {
      [d.device_id, d.recorded_by] = d.server_id === 'p_otieno' ? ['d_counter1', 'p_otieno'] : ['d_counter2', 'p_mwangi'];
      return;
    }
    seen += d.amount;
    if (wanjiku + d.amount <= (seen * wanjikuTarget) / eveningTotal + 400 && wanjiku + d.amount <= wanjikuTarget) {
      [d.device_id, d.recorded_by] = ['d_counter1', 'p_wanjiku'];
      wanjiku += d.amount;
    } else if (i % 9 === 4) {
      [d.device_id, d.recorded_by] = d.server_id === 'p_kiprop' ? ['d_counter2', 'p_kiprop'] : ['d_counter1', 'p_otieno'];
    } else {
      [d.device_id, d.recorded_by] = d.created_at < at('20:00') ? ['d_counter2', 'p_mwangi'] : ['d_counter2', 'p_akinyi'];
    }
  });

  // ---- numbers: the pinned ones as the seed has them, the rest in time order
  const reserved = new Set([...open.map((o) => o.short_no), ...pinned.map((d) => d.short_no!)]);
  let next = 1;
  for (const d of drafts) {
    if (d.short_no) continue;
    while (reserved.has(`#${String(next).padStart(3, '0')}`)) next++;
    d.short_no = `#${String(next++).padStart(3, '0')}`;
  }

  // ---- records -------------------------------------------------------------
  const orders: Order[] = [...open];
  const lines: OrderLine[] = [...openLines];
  const payments: Payment[] = [...base.payments];
  const tables = ['Table 1', 'Table 2', 'Table 3', 'Table 5', 'Table 6', 'Table 8', 'Table 10', 'Table 11', 'Counter', 'Counter', 'Takeaway'];
  const mpesaCode = () =>
    Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'[Math.floor(random() * 34)]).join('');

  const paymentDrafts: { order: Order; amount: number; recorded_by: Id; device_id: Id; created_at: Instant; locked?: PaymentMethod }[] = [];
  for (const d of drafts) {
    const id = `o_${d.short_no!.slice(1)}`;
    const order: Order = {
      id,
      short_no: d.short_no!,
      short_no_provisional: false,
      label: d.label ?? pick(tables),
      server_id: d.server_id,
      business_day: SAMPLE_DAY,
      status: 'paid',
      handed_over_to: null,
      handover_pending: false,
      recorded_by: d.recorded_by!,
      device_id: d.device_id!,
      created_at: d.created_at,
      synced_at: addMinutes(d.created_at, 1),
    };
    orders.push(order);
    compose(d.amount, d.fixed).forEach(([size_id, qty], i) => {
      const size = sizeById.get(size_id)!;
      lines.push({
        id: `${id}_l${i}`,
        order_id: id,
        product_id: productOf(size_id),
        size_id,
        qty,
        unit_price_kes: size.price_kes,
        status: 'active',
        keg_id: size.product_id === 'keg' ? 'k08' : null,
        recorded_by: order.recorded_by,
        device_id: order.device_id,
        created_at: order.created_at,
        synced_at: order.synced_at,
      });
    });
    // Most are "Record & paid"; some are paid a few minutes later, inside the shift.
    const shiftEnd = d.recorded_by === 'p_mwangi' ? at('20:00') : addMinutes(SAMPLE_NOW, -1);
    let paidAt = random() < 0.6 ? d.created_at : addMinutes(d.created_at, 3 + Math.floor(random() * 25));
    if (paidAt > shiftEnd) paidAt = d.created_at;
    if (d.short_no === '#046') paidAt = at('01:28');
    paymentDrafts.push({ order, amount: d.amount, recorded_by: d.recorded_by!, device_id: d.device_id!, created_at: paidAt,
      locked: d.short_no === '#022' || d.short_no === '#046' ? 'mpesa' : undefined });
  }

  // Wanjiku's exact share: the first of her later payments to overshoot, or
  // someone else's late one, is split between her and the other person.
  const wanjikuPaid = () => paymentDrafts.filter((p) => p.recorded_by === 'p_wanjiku').reduce((s, p) => s + p.amount, 0);
  const gap = wanjikuTarget - wanjikuPaid();
  if (gap !== 0) {
    const late = [...paymentDrafts].reverse().find((p) =>
      gap > 0 ? p.recorded_by === 'p_akinyi' && p.amount > gap : p.recorded_by === 'p_wanjiku' && p.amount > -gap);
    if (!late) throw new Error(`sample day: cannot settle Wanjiku's ${gap}`);
    const share = gap > 0 ? gap : late.amount + gap;
    paymentDrafts.push({ ...late, amount: late.amount - share, recorded_by: gap > 0 ? 'p_akinyi' : 'p_otieno', device_id: gap > 0 ? 'd_counter2' : 'd_counter1', created_at: addMinutes(late.created_at, 2) });
    Object.assign(late, { amount: share, recorded_by: 'p_wanjiku', device_id: 'd_counter1' });
  }

  // Cash per shift as the seed has it; everything else is M-Pesa.
  const cashTarget: Record<Id, number> = {
    p_mwangi: rawSeed.shifts[0]!.cash_sales_kes,
    p_wanjiku: rawSeed.shifts[1]!.cash_sales_kes - 400,
    p_akinyi: rawSeed.shifts[2]!.cash_sales_kes,
  };
  const method = new Map<object, PaymentMethod>();
  for (const [person, target] of Object.entries(cashTarget)) {
    const pool = paymentDrafts.filter((p) => p.recorded_by === person && !p.locked);
    const poolTotal = pool.reduce((s, p) => s + p.amount, 0);
    let cash = 0;
    let running = 0;
    for (const p of pool) {
      running += p.amount;
      const take = cash + p.amount <= target && cash + p.amount <= (running * target) / poolTotal + 600;
      method.set(p, take ? 'cash' : 'mpesa');
      if (take) cash += p.amount;
    }
    // Settle the last few shillings exactly by splitting one M-Pesa payment.
    for (const p of [...pool].reverse()) {
      if (cash === target) break;
      if (method.get(p) !== 'mpesa') continue;
      const need = target - cash;
      if (p.amount <= need) {
        method.set(p, 'cash');
        cash += p.amount;
      } else {
        const cashPart = { ...p, amount: need };
        paymentDrafts.push(cashPart);
        method.set(cashPart, 'cash');
        p.amount -= need;
        cash += need;
      }
    }
    if (cash !== target) throw new Error(`sample day: ${person} cash is ${cash}, not ${target}`);
  }

  paymentDrafts
    .filter((p) => p.amount > 0)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.order.short_no.localeCompare(b.order.short_no))
    .forEach((p, i) => {
      const m = method.get(p) ?? 'mpesa';
      const withoutCode = p.order.short_no === '#022' || p.order.short_no === '#046';
      payments.push({
        id: `${p.order.id}_p${i}`,
        order_id: p.order.id,
        method: m,
        amount_kes: p.amount,
        mpesa_ref_last4: m === 'mpesa' && !withoutCode ? mpesaCode() : null,
        recorded_by: p.recorded_by,
        device_id: p.device_id,
        created_at: p.created_at,
        synced_at: addMinutes(p.created_at, 1),
      });
    });

  // ---- K-07: tapped Monday evening, finished 20:08 Tuesday. Its sales were
  // on Monday's business day, by server as the seed has them.
  const monday = '2026-11-09';
  const k07 = rawSeed.kegs[0]!;
  let mondayNo = 60;
  for (const [server, sold] of Object.entries(k07.recorded_by_server!)) {
    let m = sold.mugs;
    let j = sold.jugs;
    while (m > 0 || j > 0) {
      const takeJ = j > 0 && random() < 0.3 ? 1 : 0;
      const takeM = takeJ ? 0 : Math.min(m, 1 + Math.floor(random() * 3));
      j -= takeJ;
      m -= takeM;
      const created = at(`${String(18 + Math.floor(random() * 6)).padStart(2, '0')}:${String(30 + Math.floor(random() * 29)).padStart(2, '0')}`, monday);
      const id = `o_mon_${mondayNo}`;
      const device = server === 'p_otieno' ? 'd_counter1' : 'd_counter2';
      const order: Order = {
        id, short_no: `#${String(mondayNo++).padStart(3, '0')}`, short_no_provisional: false, label: pick(tables),
        server_id: server, business_day: monday, status: 'paid', handed_over_to: null, handover_pending: false,
        recorded_by: server, device_id: device, created_at: created, synced_at: addMinutes(created, 1),
      };
      const size = takeJ ? jug : mug;
      const qty = takeJ || takeM;
      orders.push(order);
      lines.push({ id: `${id}_l0`, order_id: id, product_id: 'keg', size_id: size.id, qty, unit_price_kes: size.price_kes, status: 'active',
        keg_id: 'k07', recorded_by: server, device_id: device, created_at: created, synced_at: order.synced_at });
      payments.push({ id: `${id}_p0`, order_id: id, method: 'mpesa', amount_kes: qty * size.price_kes, mpesa_ref_last4: mpesaCode(),
        recorded_by: server, device_id: device, created_at: created, synced_at: order.synced_at });
    }
  }
  const kegs = base.kegs.map((k) => ({ ...k, recorded_ml_baseline: 0, checked_at: null, checked_by: null, written_off_cups: null }));

  // ---- voids, the write-off, the price mismatch and the comp ------------------
  const lineOf = (orderId: Id, sizeId: Id) => lines.find((l) => l.order_id === orderId && l.size_id === sizeId)!;
  const guinness = lineOf('o_039', 'guinness_0');
  guinness.status = 'void_pending';
  for (const line of lines.filter((l) => l.order_id === 'o_041')) line.status = 'void_pending';
  const tuskerOn036 = lineOf('o_036', 'tusker_0');

  const approval = (a: Partial<ApprovalItem> & Pick<ApprovalItem, 'id' | 'kind' | 'target' | 'amount_kes' | 'reason_code' | 'requested_by' | 'device_id' | 'requested_at'>): ApprovalItem =>
    ({ status: 'waiting', decided_by: null, decided_at: null, note: null, detail: null, ...a });
  const approvals: ApprovalItem[] = [
    approval({ id: 'a_void_039', kind: 'void', target: { order_id: 'o_039', line_ids: [guinness.id], whole_order: false },
      amount_kes: 330, reason_code: 'changed', requested_by: 'p_otieno', device_id: 'd_counter1', requested_at: at('02:09') }),
    approval({ id: 'a_void_041', kind: 'void', target: { order_id: 'o_041', line_ids: lines.filter((l) => l.order_id === 'o_041').map((l) => l.id), whole_order: true },
      amount_kes: 2300, reason_code: 'mistake', note: 'duplicate of #042', requested_by: 'p_akinyi', device_id: 'd_counter2', requested_at: at('01:48') }),
    approval({ id: 'a_wo_tusker', kind: 'write_off', target: { order_id: null, line_ids: [], whole_order: false, item: { product_id: 'tusker', size_id: 'tusker_0', qty: 2 } },
      amount_kes: 600, reason_code: 'spilled', requested_by: 'p_otieno', device_id: 'd_counter1', requested_at: at('21:40') }),
    approval({ id: 'a_price_036', kind: 'price_mismatch', target: { order_id: 'o_036', line_ids: [tuskerOn036.id], whole_order: false },
      amount_kes: 20, reason_code: 'price_mismatch', requested_by: 'system', device_id: 'd_counter2', requested_at: at('20:02'),
      detail: { order_id: 'o_036', line_id: tuskerOn036.id, product_name: 'Tusker Lager', size_label: '500ml', qty: 1,
        recorded_price_kes: 300, server_price_kes: 320, server_price_since: at('19:30'), offline: true } }),
    approval({ id: 'a_comp_046', kind: 'comp', target: { order_id: 'o_046', line_ids: [], whole_order: false, item: { product_id: 'cane', size_id: 'cane_0', qty: 1 } },
      amount_kes: 80, reason_code: 'other', note: 'Regular customer’s birthday', requested_by: 'p_kiprop', device_id: 'd_counter2', requested_at: at('01:30') }),
  ];
  // Broken bottles come off the shelf when reported (Approvals: "Already taken off: 2 bottles").
  const stockMovements: StockMovement[] = [
    { id: 'a_wo_tusker:write_off', product_id: 'tusker', delta: -2, reason: 'write_off', ref_id: 'a_wo_tusker', recorded_by: 'p_otieno', created_at: at('21:40') },
  ];

  // ---- shifts as they stand at 02:14 ---------------------------------------
  const shifts: Shift[] = rawSeed.shifts.map((s) => ({
    id: `s_${s.person_id}`,
    person_id: s.person_id,
    device_id: s.device_id,
    opened_at: at(s.opened_local),
    float_kes: s.float_kes,
    expenses: s.expenses,
    closed_at: s.closed_local ? at(s.closed_local) : null,
    counted_cash_kes: s.counted_kes,
    result_kes: s.result_kes,
    cash_baseline_kes: 0,
    mpesa_baseline_kes: 0,
  }));

  // K-09 arrived with delivery note DN-20418 and waits in the queue (R-STOCK-4).
  const deliveries: Delivery[] = [
    { id: 'dl_20418', supplier: null, note_no: rawSeed.kegs[2]!.delivery_note!, received_by: 'p_njeri', created_at: at('14:05'),
      lines: [{ product_id: 'keg', container_label: 'Keg 50 L', container_qty: 1, per_container: 50_000, total: 50_000 }], keg_ids: ['k09'] },
  ];

  const people = base.people.map((p) => (p.id === 'p_otieno' ? { ...p, failed_pin_attempts: 5 } : p));

  return {
    ...base,
    people,
    kegs,
    orders,
    lines,
    payments,
    shifts,
    approvals,
    deliveries,
    stockMovements,
    auditEvents: sampleAudit({ orders, lines, payments, shifts, approvals, deliveries }),
  };
}

/**
 * The audit log for the sample day, in the shape the server keeps it: one row
 * per event, with the event's payload as the detail.
 */
function sampleAudit(day: Pick<SampleDay, 'orders' | 'lines' | 'payments' | 'shifts' | 'approvals' | 'deliveries'>): AuditEvent[] {
  const rows: AuditEvent[] = [];
  const add = (row: Omit<AuditEvent, 'id' | 'synced_at'> & { synced_at?: Instant | null }) =>
    rows.push({ synced_at: row.at, ...row, id: `ae_${rows.length + 1}` });

  for (const order of day.orders.filter((o) => o.business_day === SAMPLE_DAY)) {
    const lines = day.lines.filter((l) => l.order_id === order.id);
    const firstPayment = day.payments.filter((p) => p.order_id === order.id && p.created_at === order.created_at);
    add({ at: order.created_at, actor_id: order.recorded_by, device_id: order.device_id, kind: 'order_recorded', ref_id: order.id,
      detail: { order, lines, payments: firstPayment }, synced_at: order.synced_at });
  }
  const atOrder = new Set(day.orders.map((o) => `${o.id}|${o.created_at}`));
  for (const p of day.payments.filter((p) => !atOrder.has(`${p.order_id}|${p.created_at}`))) {
    const order = day.orders.find((o) => o.id === p.order_id)!;
    if (order.business_day !== SAMPLE_DAY) continue;
    add({ at: p.created_at, actor_id: p.recorded_by, device_id: p.device_id, kind: 'payment_recorded', ref_id: p.order_id,
      detail: { order_id: p.order_id, payments: [p] }, synced_at: p.synced_at });
  }
  for (const s of day.shifts) {
    add({ at: s.opened_at, actor_id: s.person_id, device_id: s.device_id, kind: 'shift_opened', ref_id: s.id, detail: { shift: s } });
    if (s.closed_at) {
      add({ at: s.closed_at, actor_id: s.person_id, device_id: s.device_id, kind: 'shift_closed', ref_id: s.id,
        detail: { shift_id: s.id, closed_at: s.closed_at, counted_cash_kes: s.counted_cash_kes, result_kes: s.result_kes } });
    }
  }
  for (const a of day.approvals.filter((a) => a.requested_by !== 'system')) {
    add({ at: a.requested_at, actor_id: a.requested_by, device_id: a.device_id, kind: 'void_requested', ref_id: a.target.order_id ?? a.id,
      detail: { order_id: a.target.order_id, approval: a } });
  }
  for (const d of day.deliveries) {
    add({ at: d.created_at, actor_id: d.received_by, device_id: null, kind: 'delivery_recorded', ref_id: d.id, detail: { delivery: d } });
  }
  // Offline for a while on Counter 2: saved 19:52, reached the server 20:02.
  const mismatch = rows.find((r) => r.ref_id === 'o_036' && r.kind === 'order_recorded');
  if (mismatch) mismatch.synced_at = instantOnBusinessDay(SAMPLE_DAY, '20:02', '06:00');
  add({ at: instantOnBusinessDay(SAMPLE_DAY, '20:08', '06:00'), actor_id: 'p_otieno', device_id: 'd_counter1', kind: 'keg_finished', ref_id: 'k07',
    detail: { keg_id: 'k07', next_keg_id: 'k08' } });
  add({ at: instantOnBusinessDay(SAMPLE_DAY, '19:30', '06:00'), actor_id: 'p_njeri', device_id: null, kind: 'login', ref_id: 'p_njeri', detail: { person_id: 'p_njeri' } });
  add({ at: '2026-11-10T23:09:00.000Z', actor_id: 'p_otieno', device_id: 'd_counter1', kind: 'pin_failed', ref_id: 'p_otieno',
    detail: { person_id: 'p_otieno', failed_pin_attempts: 5, pin_locked_until: '2026-11-10T23:14:00.000Z' } });
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}
