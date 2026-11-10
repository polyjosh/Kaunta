import { describe, expect, it } from 'vitest';
import { kegFinishSummary, kegRecordedMl } from './kegs';
import { orderDue, orderTotal, paidTotal } from './orders';
import { SAMPLE_DAY, loadSampleDay } from './sampleDay';
import { rawSeed } from './seed';
import { expectedCash, shiftPayments } from './shifts';
import { localTime } from './time';

const day = loadSampleDay();
const today = day.orders.filter((o) => o.business_day === SAMPLE_DAY);
const todayIds = new Set(today.map((o) => o.id));
const lines = day.lines.filter((l) => todayIds.has(l.order_id));
const payments = day.payments.filter((p) => todayIds.has(p.order_id));
const summary = rawSeed.today_summary;

describe('sample day (admin): records add up to the seed totals', () => {
  it('is the same every time', () => {
    expect(JSON.stringify(loadSampleDay())).toBe(JSON.stringify(day));
  });

  it('served, collected and money at risk (R-DAY-4)', () => {
    expect(orderTotal(lines)).toBe(summary.served_kes);
    expect(paidTotal(payments)).toBe(summary.collected_kes);
    expect(orderTotal(lines) - paidTotal(payments)).toBe(summary.money_at_risk_kes);
  });

  it('cash and M-Pesa', () => {
    const by = (m: string) => paidTotal(payments.filter((p) => p.method === m));
    expect(by('cash')).toBe(summary.cash_kes);
    expect(by('mpesa')).toBe(summary.mpesa_kes);
    expect(by('mpesa')).toBe(rawSeed.day_close.recorded_mpesa_kes);
  });

  it('only the five open orders still owe money, and every order is fully paid or open', () => {
    const owing = today.filter((o) => orderDue(day.lines.filter((l) => l.order_id === o.id), day.payments.filter((p) => p.order_id === o.id)) > 0);
    expect(owing.map((o) => o.short_no).sort()).toEqual(['#039', '#041', '#044', '#047', '#048']);
    expect(today.filter((o) => o.status === 'open').map((o) => o.short_no).sort()).toEqual(['#039', '#041', '#044', '#047', '#048']);
    for (const o of today) {
      const paid = paidTotal(day.payments.filter((p) => p.order_id === o.id));
      expect(paid).toBeLessThanOrEqual(orderTotal(day.lines.filter((l) => l.order_id === o.id)));
    }
  });

  it('by server: served, collected, not paid', () => {
    for (const [server, s] of Object.entries(summary.by_server)) {
      const mine = new Set(today.filter((o) => o.server_id === server).map((o) => o.id));
      const served = orderTotal(lines.filter((l) => mine.has(l.order_id)));
      const collected = paidTotal(payments.filter((p) => mine.has(p.order_id)));
      expect({ server, served, collected, notPaid: served - collected }).toEqual({
        server,
        served: s.served_kes,
        collected: s.collected_kes,
        notPaid: s.not_paid_kes,
      });
    }
  });

  it('by hour, from when each order was recorded', () => {
    const byHour: Record<string, number> = {};
    for (const o of today) {
      const h = localTime(o.created_at).slice(0, 2);
      byHour[h] = (byHour[h] ?? 0) + orderTotal(lines.filter((l) => l.order_id === o.id));
    }
    expect(byHour).toEqual(summary.by_hour_kes);
  });

  it('every shift has the cash the seed says, and Wanjiku is KES 300 short (R-SHIFT-2)', () => {
    for (const s of rawSeed.shifts) {
      const shift = day.shifts.find((x) => x.person_id === s.person_id)!;
      const mine = shiftPayments(shift, day.payments);
      expect(paidTotal(mine.filter((p) => p.method === 'cash'))).toBe(s.cash_sales_kes);
      expect(expectedCash(shift, mine)).toBe(s.expected_kes);
    }
    const wanjiku = day.shifts.find((s) => s.person_id === 'p_wanjiku')!;
    expect(paidTotal(shiftPayments(wanjiku, day.payments).filter((p) => p.method === 'mpesa'))).toBe(18_400);
    expect(wanjiku.result_kes).toBe(-300);
  });

  it('every cash payment falls in somebody’s open shift', () => {
    for (const p of payments.filter((p) => p.method === 'cash')) {
      expect(day.shifts.some((s) => shiftPayments(s, [p]).length === 1)).toBe(true);
    }
  });

  it('M-Pesa without a code: exactly the two the seed lists (R-DAY-3)', () => {
    const noCode = payments.filter((p) => p.method === 'mpesa' && p.mpesa_ref_last4 === null);
    const listed = noCode.map((p) => ({
      order: today.find((o) => o.id === p.order_id)!.short_no,
      amount_kes: p.amount_kes,
      by: p.recorded_by,
    }));
    expect(listed.sort((a, b) => a.order.localeCompare(b.order))).toEqual(
      [...rawSeed.day_close.mpesa_without_code].sort((a, b) => a.order.localeCompare(b.order)),
    );
    for (const p of payments.filter((p) => p.mpesa_ref_last4 !== null)) expect(p.mpesa_ref_last4).toMatch(/^[A-Z0-9]{4}$/);
  });

  it('order numbers are unique per day, and the ones the designs name are there', () => {
    const nos = today.map((o) => o.short_no);
    expect(new Set(nos).size).toBe(nos.length);
    for (const no of ['#022', '#036', '#039', '#041', '#042', '#044', '#046', '#047', '#048']) expect(nos).toContain(no);
    const n042 = today.find((o) => o.short_no === '#042')!;
    expect(orderTotal(day.lines.filter((l) => l.order_id === n042.id))).toBe(2300);
  });

  it('only sells what the counter could sell, at menu prices', () => {
    const sizes = new Map(day.sizes.map((s) => [s.id, s]));
    for (const l of day.lines) {
      expect(l.unit_price_kes).toBe(sizes.get(l.size_id)!.price_kes);
      expect(day.products.find((p) => p.id === l.product_id)!.manual_out_of_stock).toBe(false);
    }
  });

  it('kegs: K-08 has ~31 L left, K-07 finished 9 cups short (R-KEG-2, R-KEG-3)', () => {
    const sizes = new Map(day.sizes.map((s) => [s.id, s]));
    const k08 = day.kegs.find((k) => k.id === 'k08')!;
    expect(k08.volume_ml - kegRecordedMl(k08, day.lines, sizes)).toBe(31_000);
    const k07 = day.kegs.find((k) => k.id === 'k07')!;
    expect(kegFinishSummary(k07, kegRecordedMl(k07, day.lines, sizes), 0, 120)).toEqual({
      expected_cups: 100,
      recorded_cups: 91,
      short_cups: 9,
      short_value_kes: 1080,
    });
  });

  it('the five approvals are waiting, voided lines still count until decided (R-VOID-2)', () => {
    expect(day.approvals.map((a) => [a.kind, a.amount_kes, a.status])).toEqual([
      ['void', 330, 'waiting'],
      ['void', 2300, 'waiting'],
      ['write_off', 600, 'waiting'],
      ['price_mismatch', 20, 'waiting'],
      ['comp', 80, 'waiting'],
    ]);
    expect(lines.filter((l) => l.status === 'void_pending').length).toBe(5);
  });

  it('has an audit row for every order of the day, oldest first', () => {
    const recorded = day.auditEvents.filter((e) => e.kind === 'order_recorded');
    expect(recorded.length).toBe(today.length);
    const times = day.auditEvents.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
  });
});
