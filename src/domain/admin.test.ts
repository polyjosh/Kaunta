import { describe, expect, it } from 'vitest';
import {
  attentionFlags,
  auditGroup,
  byServer,
  canCloseDay,
  feedRows,
  filterAudit,
  kegSummary,
  mpesaRecon,
  mpesaVariance,
  salesByHour,
  shiftRecon,
  toCsv,
  todaySummary,
} from './admin';
import type { DayData } from './admin';
import { SAMPLE_DAY, loadSampleDay } from './sampleDay';

const sample = loadSampleDay();
const orders = sample.orders.filter((o) => o.business_day === SAMPLE_DAY);
const data: DayData = { ...sample, orders, dayClose: null };

describe('Today (R-DAY-4)', () => {
  it('matches the seed: 86,450 served, 79,970 collected, 6,480 at risk on 5 open orders', () => {
    expect(todaySummary(data)).toEqual({
      served_kes: 86_450,
      collected_kes: 79_970,
      money_at_risk_kes: 6_480,
      open_orders: 5,
      cash_kes: 31_570,
      mpesa_kes: 48_400,
    });
  });

  it('only counts orders of the day it is given', () => {
    expect(todaySummary({ ...data, orders: sample.orders.filter((o) => o.business_day === '2026-11-09') }).served_kes).toBe(
      sample.kegs.length > 0 ? 75 * 120 + 4 * 450 : 0,
    );
  });

  it('sales by hour, 16:00 to 02:00, peak at 22:00', () => {
    const hours = salesByHour(data);
    expect(hours.map((h) => h.hour)).toEqual(['16', '17', '18', '19', '20', '21', '22', '23', '00', '01', '02']);
    expect(hours.find((h) => h.hour === '22')!.amount_kes).toBe(14_300);
    expect(Math.max(...hours.map((h) => h.amount_kes))).toBe(14_300);
  });

  it('by server, biggest first, with not-paid from open orders', () => {
    expect(byServer(data).map((s) => [s.person_id, s.served_kes, s.collected_kes, s.not_paid_kes])).toEqual([
      ['p_otieno', 24_300, 22_820, 1_480],
      ['p_akinyi', 21_850, 19_550, 2_300],
      ['p_wanjiku', 19_600, 17_750, 1_850],
      ['p_kiprop', 14_900, 14_050, 850],
      ['p_mwangi', 5_800, 5_800, 0],
    ]);
  });

  it('flags: negative stock, voids, write-off, price mismatch, keg short, shift short', () => {
    const flags = attentionFlags(data, SAMPLE_DAY);
    expect(flags.map((f) => f.kind)).toEqual(['negativeStock', 'voids', 'writeOffs', 'priceMismatch', 'kegShort', 'shiftShort']);
    const [stock, voids, wo, price, keg, shift] = flags as any[];
    expect([stock.product_id, stock.qty]).toEqual(['pilsner', -4]);
    expect([voids.approvals.length, voids.amount_kes]).toEqual([2, 2_630]);
    expect(wo.amount_kes).toBe(600);
    expect(price.amount_kes).toBe(20);
    expect([keg.keg.code, keg.short_cups, keg.expected_cups, keg.recorded_cups, keg.value_kes]).toEqual(['K-07', 9, 100, 91, 1_080]);
    expect([shift.shift.person_id, shift.amount_kes]).toEqual(['p_wanjiku', 300]);
  });

  it('no keg flag once the keg is checked; no approval flags once decided', () => {
    const quiet: DayData = {
      ...data,
      kegs: data.kegs.map((k) => ({ ...k, checked_at: '2026-11-10T23:20:00.000Z' })),
      approvals: data.approvals.map((a) => ({ ...a, status: 'approved' as const })),
    };
    expect(attentionFlags(quiet, SAMPLE_DAY).map((f) => f.kind)).toEqual(['negativeStock', 'shiftShort']);
  });
});

describe('Kegs (R-KEG-2, R-KEG-3)', () => {
  const k07 = sample.kegs.find((k) => k.id === 'k07')!;
  it('K-07: 100 expected, 91 recorded, 9 short ≈ KES 1,080, by server', () => {
    const s = kegSummary(k07, sample);
    expect([s.expected_cups, s.recorded_cups, s.short_cups, s.short_value_kes]).toEqual([100, 91, 9, 1_080]);
    expect(s.by_server).toEqual([
      { person_id: 'p_otieno', mugs: 31, jugs: 2, cups: 39 },
      { person_id: 'p_akinyi', mugs: 24, jugs: 1, cups: 28 },
      { person_id: 'p_kiprop', mugs: 20, jugs: 1, cups: 24 },
    ]);
  });
  it('the foam allowance comes off the shortfall', () => {
    const s = kegSummary(k07, { ...sample, bar: { ...sample.bar, keg_foam_allowance_cups: 4 } });
    expect(s.short_cups).toBe(5);
  });
  it('K-08: ~31 L left', () => {
    expect(kegSummary(sample.kegs.find((k) => k.id === 'k08')!, sample).remaining_ml).toBe(31_000);
  });
});

describe('Reconcile (R-SHIFT-2, R-DAY-3)', () => {
  it('cash per shift: Mwangi matches, Wanjiku short 300, Akinyi open', () => {
    const rows = shiftRecon(sample, SAMPLE_DAY);
    expect(rows.map((r) => [r.shift.person_id, r.shift.float_kes, r.cash_sales_kes, r.expenses_kes, r.expected_kes, r.result])).toEqual([
      ['p_mwangi', 2_000, 6_820, 0, 8_820, { kind: 'matches', amount_kes: 0 }],
      ['p_wanjiku', 2_000, 11_950, 1_200, 12_750, { kind: 'short', amount_kes: 300 }],
      ['p_akinyi', 2_000, 12_800, 0, 14_800, null],
    ]);
    expect(canCloseDay(rows, 47_650)).toBe(false);
    expect(canCloseDay(rows.slice(0, 2), null)).toBe(false);
    expect(canCloseDay(rows.slice(0, 2), 47_650)).toBe(true);
  });

  it('M-Pesa: 48,400 recorded, two without a code, variance against the till', () => {
    const m = mpesaRecon(data);
    expect(m.recorded_kes).toBe(48_400);
    expect(m.payments - m.with_code).toBe(2);
    expect(m.without_code.map((p) => p.amount_kes)).toEqual([750, 600]);
    expect(mpesaVariance(48_400, 47_650)).toEqual({ kind: 'notOnTill', amount_kes: 750 });
    expect(mpesaVariance(48_400, 49_000)).toEqual({ kind: 'notRecorded', amount_kes: 600 });
    expect(mpesaVariance(48_400, 48_400)).toEqual({ kind: 'matches', amount_kes: 0 });
  });
});

describe('Feed', () => {
  const rows = feedRows(sample.auditEvents, data);
  it('newest first, every order of the day appears, approvals as needs review', () => {
    expect([...rows].sort((a, b) => b.at.localeCompare(a.at)).map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(new Set(rows.filter((r) => r.order && (r.kind === 'served' || r.kind === 'paid')).map((r) => r.order!.id)).size).toBe(orders.length);
    expect(rows.filter((r) => r.kind === 'review').map((r) => r.approval!.kind).sort()).toEqual(['comp', 'price_mismatch', 'void', 'void', 'write_off']);
  });
  it('a pay-later order is "served"; a paid-at-once one is "paid"', () => {
    expect(rows.find((r) => r.order?.short_no === '#048')!.kind).toBe('served');
  });
});

describe('Audit (R-AUD-2)', () => {
  const describe = (e: { kind: string }) => e.kind;
  it('groups every kind it knows', () => {
    expect(auditGroup('order_recorded')).toBe('sales');
    expect(auditGroup('approval_decided')).toBe('voids');
    expect(auditGroup('device_revoked')).toBe('logins');
    expect(auditGroup('day_closed')).toBe('shifts');
  });
  it('filters by person, kind group and free text (order no., M-Pesa code)', () => {
    const all = filterAudit(sample.auditEvents, { day: SAMPLE_DAY }, '06:00', describe);
    expect(all.length).toBeGreaterThan(90);
    expect(filterAudit(sample.auditEvents, { person: 'p_mwangi', groups: ['shifts'] }, '06:00', describe).map((e) => e.kind)).toEqual(['shift_closed', 'shift_opened']);
    expect(filterAudit(sample.auditEvents, { text: '#042' }, '06:00', describe).some((e) => e.ref_id === 'o_042')).toBe(true);
    const code = sample.payments.find((p) => p.mpesa_ref_last4 && p.order_id.startsWith('o_0'))!;
    expect(filterAudit(sample.auditEvents, { text: code.mpesa_ref_last4!.toLowerCase() }, '06:00', describe).length).toBeGreaterThan(0);
  });
  it('CSV quotes every field', () => {
    expect(toCsv([['a', 'b "c"'], [1, null]])).toBe('"a","b ""c"""\r\n"1",""\r\n');
  });
});
