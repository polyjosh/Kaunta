import { describe, expect, it } from 'vitest';
import { kegFinishSummary, kegRemainingMl } from './kegs';
import { dayTotals, isAgeing, orderDue, orderTotal, paymentState } from './orders';
import { loadSeed, rawSeed } from './seed';
import { isLowStock, isNegativeStock, isSellable } from './stock';
import { businessDayOf, localTime, minutesBetween } from './time';

const seed = loadSeed();
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const linesOf = (orderId: string) => seed.lines.filter((l) => l.order_id === orderId);
const paymentsOf = (orderId: string) => seed.payments.filter((p) => p.order_id === orderId);

describe('seed: catalogue', () => {
  it('loads Baraka Pub with the designed rule settings', () => {
    expect(seed.bar).toMatchObject({
      name: 'Baraka Pub',
      day_start: '06:00',
      self_void_minutes: 5,
      ageing_minutes: 30,
      pin_attempts: 5,
      lockout_minutes: 5,
    });
  });

  it('has the five categories in counter order', () => {
    expect([...seed.categories].sort((a, b) => a.sort - b.sort).map((c) => c.name_en)).toEqual([
      'Beer',
      'Spirits',
      'Keg',
      'Soft drinks',
      'Food',
    ]);
  });

  it('gives every size a product and every product a category and at least one size', () => {
    const productIds = new Set(seed.products.map((p) => p.id));
    const categoryIds = new Set(seed.categories.map((c) => c.id));
    for (const size of seed.sizes) expect(productIds, size.id).toContain(size.product_id);
    for (const product of seed.products) {
      expect(categoryIds, product.id).toContain(product.category_id);
      expect(seed.sizes.some((s) => s.product_id === product.id), product.id).toBe(true);
    }
  });

  it('uses integer money and quantities everywhere', () => {
    for (const size of seed.sizes) {
      expect(Number.isInteger(size.price_kes), size.id).toBe(true);
      expect(Number.isInteger(size.deduct), size.id).toBe(true);
    }
    for (const product of seed.products) {
      if (product.stock_qty !== null) expect(Number.isInteger(product.stock_qty), product.id).toBe(true);
    }
  });

  it('matches the tile states in the designs', () => {
    const product = (id: string) => seed.products.find((p) => p.id === id)!;
    expect(isSellable(product('cider'))).toBe(false); // Tusker Cider: out of stock
    expect(isNegativeStock(product('pilsner'))).toBe(true); // Pilsner at −4
    expect(isLowStock(product('tonic'))).toBe(true); // 4 left, alert at 6
    expect(isLowStock(product('cane'))).toBe(false); // ml mode never shows "N left"
    expect(seed.sizes.filter((s) => s.product_id === 'cane').map((s) => s.deduct)).toEqual([30, 250, 350, 750, 1000]);
  });

  it('keeps demo PINs out of the person records', () => {
    // Wanjiku's from the handoff; the demo gives the other counter staff one too.
    expect(seed.demoPins).toEqual({ p_wanjiku: '2580', p_otieno: '1470', p_akinyi: '3691', p_kiprop: '8024', p_mwangi: '5813' });
    for (const person of seed.people) {
      expect(person.pin_hash).toBeNull();
      expect(person).not.toHaveProperty('demo_pin');
    }
  });

  it('marks the lost phone as revoked with its reason', () => {
    expect(seed.devices.find((d) => d.id === 'd_old')).toMatchObject({ revoked_reason: 'Phone lost' });
    expect(seed.devices.filter((d) => d.revoked_at === null)).toHaveLength(2);
  });
});

describe('seed: open orders', () => {
  it('computes each order’s total and due as the file states them', () => {
    for (const o of rawSeed.open_orders) {
      const id = `o_${o.short_no.replace('#', '')}`;
      expect(orderTotal(linesOf(id)), o.short_no).toBe(o.total_kes);
      expect(orderDue(linesOf(id), paymentsOf(id)), o.short_no).toBe(o.due_kes);
    }
  });

  it('money at risk 6,480 = sum of open-order dues = served − collected', () => {
    const dues = seed.orders.map((o) => orderDue(linesOf(o.id), paymentsOf(o.id)));
    expect(sum(dues)).toBe(6480);
    expect(sum(dues)).toBe(rawSeed.today_summary.money_at_risk_kes);
    expect(rawSeed.today_summary.served_kes - rawSeed.today_summary.collected_kes).toBe(6480);
    expect(dayTotals(seed.lines, seed.payments).money_at_risk_kes).toBe(6480);
  });

  it('has Table 9 part paid: KES 400 of 1,250, KES 850 left', () => {
    expect(paymentState(linesOf('o_044'), paymentsOf('o_044'))).toBe('partPaid');
    expect(orderDue(linesOf('o_044'), paymentsOf('o_044'))).toBe(850);
  });

  it('places every order on business day 10 Nov at its local time', () => {
    for (const order of seed.orders) expect(businessDayOf(order.created_at), order.short_no).toBe('2026-11-10');
    const table9 = seed.orders.find((o) => o.id === 'o_044')!;
    expect(localTime(table9.created_at)).toBe('21:58');
    expect(table9.created_at).toBe('2026-11-10T18:58:00.000Z');
  });

  it('shows the designed ages at the 22:20 counter snapshot', () => {
    const now = '2026-11-10T19:20:00.000Z'; // 22:20 EAT
    const age = (id: string) => minutesBetween(seed.orders.find((o) => o.id === id)!.created_at, now);
    expect(age('o_041')).toBe(46); // "46 min · open long"
    expect(age('o_044')).toBe(22); // "Open 22 min · since 21:58"
    expect(age('o_047')).toBe(12);
    const ageing = seed.orders.filter((o) => isAgeing(o, now, seed.bar.ageing_minutes)).map((o) => o.short_no);
    expect(ageing.sort()).toEqual(['#039', '#041']);
  });

  it('keeps who served and who recorded apart', () => {
    expect(seed.orders.find((o) => o.id === 'o_044')).toMatchObject({ server_id: 'p_kiprop', recorded_by: 'p_wanjiku' });
  });
});

describe('seed: the day’s numbers agree with each other', () => {
  const today = rawSeed.today_summary;
  const servers = Object.values(today.by_server);

  it('served 86,450 − collected 79,970 = at risk 6,480', () => {
    expect(today.served_kes).toBe(86450);
    expect(today.collected_kes).toBe(79970);
    expect(today.served_kes - today.collected_kes).toBe(today.money_at_risk_kes);
  });

  it('cash 31,570 + M-Pesa 48,400 = collected', () => {
    expect(today.cash_kes + today.mpesa_kes).toBe(today.collected_kes);
    expect(rawSeed.day_close.recorded_mpesa_kes).toBe(today.mpesa_kes);
  });

  it('per-server and per-hour figures add up to the totals', () => {
    expect(sum(servers.map((s) => s.served_kes))).toBe(today.served_kes);
    expect(sum(servers.map((s) => s.collected_kes))).toBe(today.collected_kes);
    expect(sum(servers.map((s) => s.not_paid_kes))).toBe(today.money_at_risk_kes);
    expect(sum(Object.values(today.by_hour_kes))).toBe(today.served_kes);
  });

  it('each server’s unpaid amount is their open orders', () => {
    for (const [serverId, figures] of Object.entries(today.by_server)) {
      const due = sum(
        seed.orders.filter((o) => o.server_id === serverId).map((o) => orderDue(linesOf(o.id), paymentsOf(o.id))),
      );
      expect(due, serverId).toBe(figures.not_paid_kes);
    }
  });

  it('R-SHIFT-2 shift cash: expected = float + cash sales − expenses; Wanjiku is short KES 300', () => {
    for (const shift of rawSeed.shifts) {
      const expenses = sum(shift.expenses.map((e) => e.amount_kes));
      expect(shift.float_kes + shift.cash_sales_kes - expenses, shift.person_id).toBe(shift.expected_kes);
      if (shift.counted_kes !== null) expect(shift.counted_kes - shift.expected_kes).toBe(shift.result_kes);
    }
    expect(rawSeed.shifts.find((s) => s.person_id === 'p_wanjiku')?.result_kes).toBe(-300);
    expect(sum(rawSeed.shifts.map((s) => s.cash_sales_kes))).toBe(today.cash_kes);
  });

  it('R-DAY-3 M-Pesa variance: recorded 48,400 − till 47,650 = 750 recorded but not on the till', () => {
    expect(rawSeed.day_close.recorded_mpesa_kes - rawSeed.day_close.till_total_kes_example).toBe(750);
  });
});

describe('seed: kegs', () => {
  const keg = (id: string) => seed.kegs.find((k) => k.id === id)!;
  const mugPrice = seed.sizes.find((s) => s.id === 'keg_0')!.price_kes;

  it('has one keg on tap, one finished and one queued', () => {
    expect(seed.kegs.map((k) => k.status).sort()).toEqual(['active', 'finished', 'queued']);
  });

  it('K-08 on tap has ~31 L left of 50 L', () => {
    expect(kegRemainingMl(keg('k08'), keg('k08').recorded_ml_baseline)).toBe(31000);
  });

  it('K-07 finished 9 cups short: expected 100, recorded 91', () => {
    const summary = kegFinishSummary(
      keg('k07'),
      keg('k07').recorded_ml_baseline,
      seed.bar.keg_foam_allowance_cups,
      mugPrice,
    );
    expect(summary).toEqual({ expected_cups: 100, recorded_cups: 91, short_cups: 9, short_value_kes: 1080 });
  });

  it('K-09 is untouched in the queue', () => {
    expect(keg('k09')).toMatchObject({ status: 'queued', recorded_ml_baseline: 0, tapped_at: null });
  });
});
