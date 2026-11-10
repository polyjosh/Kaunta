import { describe, expect, it } from 'vitest';
import { uuidv7 } from './ids';
import { kegFinishSummary, kegRecordedMl, kegRemainingMl, nextQueuedKeg } from './kegs';
import { dayTotals, isAgeing, orderDue, orderTotal, paymentState, statusAfterPayment } from './orders';
import { evenShare, nextShortNo, normaliseMpesaRef, parseShortNo } from './payments';
import { deliveryTotal, enabledSizes, isLowStock, isNegativeStock, isSellable, saleDeduction } from './stock';
import { businessDayOf, instantOnBusinessDay, localTime, minutesBetween } from './time';

describe('R-DAY-1 business day (06:00 to 06:00, Nairobi)', () => {
  it('puts a sale at 02:14 on Wednesday in Tuesday’s day', () => {
    // 02:14 EAT Wed 11 Nov = 23:14 UTC Tue 10 Nov
    expect(businessDayOf('2026-11-10T23:14:00Z')).toBe('2026-11-10');
  });

  it('changes day exactly at 06:00 local', () => {
    expect(businessDayOf('2026-11-11T02:59:59Z')).toBe('2026-11-10'); // 05:59:59 EAT
    expect(businessDayOf('2026-11-11T03:00:00Z')).toBe('2026-11-11'); // 06:00:00 EAT
  });

  it('uses Nairobi time, not UTC: 23:30 UTC is already 02:30 the next morning', () => {
    expect(businessDayOf('2026-11-10T21:30:00Z')).toBe('2026-11-10'); // 00:30 EAT Wed, still Tuesday's day
    expect(businessDayOf('2026-11-10T04:00:00Z')).toBe('2026-11-10'); // 07:00 EAT Tue
    expect(businessDayOf('2026-11-10T02:00:00Z')).toBe('2026-11-09'); // 05:00 EAT Tue, Monday's day
  });

  it('honours a different day start', () => {
    expect(businessDayOf('2026-11-11T00:30:00Z', '04:00')).toBe('2026-11-10'); // 03:30 EAT
    expect(businessDayOf('2026-11-11T01:00:00Z', '04:00')).toBe('2026-11-11'); // 04:00 EAT
  });

  it('round-trips local times on a business day', () => {
    expect(instantOnBusinessDay('2026-11-10', '21:58')).toBe('2026-11-10T18:58:00.000Z');
    expect(instantOnBusinessDay('2026-11-10', '02:14')).toBe('2026-11-10T23:14:00.000Z');
    expect(instantOnBusinessDay('2026-11-10', '06:00')).toBe('2026-11-10T03:00:00.000Z');
    for (const time of ['06:00', '21:58', '23:59', '00:00', '02:14', '05:59']) {
      const instant = instantOnBusinessDay('2026-11-10', time);
      expect(businessDayOf(instant)).toBe('2026-11-10');
      expect(localTime(instant)).toBe(time);
    }
  });

  it('rejects malformed times', () => {
    expect(() => instantOnBusinessDay('2026-11-10', '6pm')).toThrow(TypeError);
    expect(() => instantOnBusinessDay('2026-11-10', '25:00')).toThrow(RangeError);
  });
});

describe('time helpers', () => {
  it('counts whole minutes and never goes negative', () => {
    expect(minutesBetween('2026-11-10T18:58:00Z', '2026-11-10T19:20:59Z')).toBe(22);
    expect(minutesBetween('2026-11-10T19:20:00Z', '2026-11-10T18:58:00Z')).toBe(0);
  });
});

describe('uuidv7', () => {
  it('is a version-7 UUID that sorts by creation time', () => {
    const early = uuidv7(1_000_000);
    const late = uuidv7(2_000_000);
    expect(early).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(early < late).toBe(true);
    expect(uuidv7(1_000_000)).not.toBe(early);
  });
});

const line = (qty: number, unit_price_kes: number, status: 'active' | 'void_pending' | 'voided' = 'active') => ({
  qty,
  unit_price_kes,
  status,
});

describe('R-ORD-2 totals, due and payment state', () => {
  const table9 = [line(2, 300), line(1, 350), line(2, 100), line(1, 100)];

  it('due = active lines − payments', () => {
    expect(orderTotal(table9)).toBe(1250);
    expect(orderDue(table9, [{ amount_kes: 400 }])).toBe(850);
  });

  it('is pending, then part paid, then paid', () => {
    expect(paymentState(table9, [])).toBe('pending');
    expect(paymentState(table9, [{ amount_kes: 400 }])).toBe('partPaid');
    expect(paymentState(table9, [{ amount_kes: 400 }, { amount_kes: 850 }])).toBe('paid');
  });

  it('keeps a void-pending line in the total until approved (R-VOID-2), and drops a voided one', () => {
    expect(orderTotal([line(1, 330, 'void_pending'), line(1, 750)])).toBe(1080);
    expect(orderTotal([line(1, 330, 'voided'), line(1, 750)])).toBe(750);
  });

  it('never reports a negative due', () => {
    expect(orderDue([line(1, 300)], [{ amount_kes: 500 }])).toBe(0);
  });

  it('derives the stored status, and leaves a voided order voided', () => {
    expect(statusAfterPayment('open', table9, [{ amount_kes: 400 }])).toBe('open');
    expect(statusAfterPayment('open', table9, [{ amount_kes: 1250 }])).toBe('paid');
    expect(statusAfterPayment('voided', table9, [{ amount_kes: 1250 }])).toBe('voided');
  });
});

describe('R-ORD-1 ageing', () => {
  const order = { status: 'open' as const, created_at: '2026-11-10T18:34:00Z' };

  it('starts after more than 30 minutes open', () => {
    expect(isAgeing(order, '2026-11-10T19:04:00Z', 30)).toBe(false); // exactly 30
    expect(isAgeing(order, '2026-11-10T19:05:00Z', 30)).toBe(true);
    expect(isAgeing(order, '2026-11-10T19:20:00Z', 30)).toBe(true); // 46 min, as designed
  });

  it('only applies to open orders', () => {
    expect(isAgeing({ ...order, status: 'paid' }, '2026-11-10T22:00:00Z', 30)).toBe(false);
  });
});

describe('R-DAY-4 day totals', () => {
  it('money at risk = served − collected', () => {
    expect(dayTotals([line(2, 300), line(1, 750)], [{ amount_kes: 600 }])).toEqual({
      served_kes: 1350,
      collected_kes: 600,
      money_at_risk_kes: 750,
    });
  });
});

describe('R-ORD-4 M-Pesa last 4', () => {
  it('is optional', () => {
    expect(normaliseMpesaRef(null)).toBeNull();
    expect(normaliseMpesaRef('  ')).toBeNull();
  });

  it('is stored uppercase', () => {
    expect(normaliseMpesaRef('qk7x')).toBe('QK7X');
  });

  it('must be exactly 4 letters or digits', () => {
    for (const bad of ['QK7', 'QK7XY', 'QK-7', 'QK 7']) expect(() => normaliseMpesaRef(bad)).toThrow(RangeError);
  });
});

describe('R-ORD-5 split evenly', () => {
  it('rounds each share up', () => {
    expect(evenShare(850, 2)).toBe(425);
    expect(evenShare(850, 3)).toBe(284);
    expect(evenShare(850, 4)).toBe(213);
  });
});

describe('R-DAY-2 order numbers', () => {
  it('restart at #001 and continue from the highest used that day', () => {
    expect(nextShortNo([])).toBe('#001');
    expect(nextShortNo(['#041', '#047', '#039'])).toBe('#048');
    expect(nextShortNo(['#999'])).toBe('#1000');
    expect(parseShortNo('#047')).toBe(47);
    expect(parseShortNo('047')).toBeNull();
  });
});

describe('stock rules', () => {
  const base = { stock_mode: 'count' as const, stock_qty: 24, low_stock_at: 6 };

  it('R-STOCK-1 deducts units in count mode and ml in ml mode', () => {
    expect(saleDeduction({ deduct: 1 }, 3)).toBe(3);
    expect(saleDeduction({ deduct: 30 }, 2)).toBe(60); // two tots
    expect(saleDeduction({ deduct: 1000 }, 1)).toBe(1000); // 1 litre
  });

  it('R-STOCK-2 converts containers to a total', () => {
    expect(deliveryTotal(3, 750)).toBe(2250);
    expect(deliveryTotal(1, 25)).toBe(25);
  });

  it('R-SELL-2 only the manual switch (or archive) blocks selling, never the count', () => {
    expect(isSellable({ manual_out_of_stock: false, archived_at: null })).toBe(true);
    expect(isSellable({ manual_out_of_stock: true, archived_at: null })).toBe(false);
    expect(isSellable({ manual_out_of_stock: false, archived_at: '2026-11-01T00:00:00Z' })).toBe(false);
  });

  it('R-SELL-6 low stock at or below the alert level, count mode only', () => {
    expect(isLowStock(base)).toBe(false);
    expect(isLowStock({ ...base, stock_qty: 6 })).toBe(true);
    expect(isLowStock({ ...base, stock_qty: 3 })).toBe(true);
    expect(isLowStock({ ...base, stock_qty: 3, low_stock_at: null })).toBe(false);
    expect(isLowStock({ stock_mode: 'ml', stock_qty: 500, low_stock_at: 1500 })).toBe(false);
    expect(isLowStock({ ...base, stock_qty: null })).toBe(false);
  });

  it('R-STOCK-3 flags stock below zero', () => {
    expect(isNegativeStock({ stock_qty: -4 })).toBe(true);
    expect(isNegativeStock({ stock_qty: 0 })).toBe(false);
    expect(isNegativeStock({ stock_qty: null })).toBe(false);
  });

  it('R-SELL-1 lists enabled sizes in order', () => {
    const sizes = [
      { id: 'b', enabled: true, sort: 1 },
      { id: 'x', enabled: false, sort: 0 },
      { id: 'a', enabled: true, sort: 0 },
    ];
    expect(enabledSizes(sizes).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('keg rules', () => {
  const keg = { id: 'k08', volume_ml: 50000, cup_ml: 500, recorded_ml_baseline: 0 };
  const sizes = new Map([
    ['keg_0', { deduct: 500 }],
    ['keg_1', { deduct: 2000 }],
  ]);
  const sale = (size_id: string, qty: number, keg_id: string | null = 'k08', status: 'active' | 'voided' = 'active') => ({
    size_id,
    qty,
    keg_id,
    status,
  });

  it('R-KEG-2 remaining = volume − Σ(qty × deduct) for lines on that keg', () => {
    const lines = [sale('keg_0', 30), sale('keg_1', 2), sale('keg_0', 5, 'k07'), sale('keg_0', 4, 'k08', 'voided')];
    const recorded = kegRecordedMl(keg, lines, sizes);
    expect(recorded).toBe(19000);
    expect(kegRemainingMl(keg, recorded)).toBe(31000); // "~31 L left"
  });

  it('R-KEG-2 never shows less than empty', () => {
    expect(kegRemainingMl(keg, 52000)).toBe(0);
  });

  it('R-KEG-3 expected 100 cups; a jug is 4 cups; short is valued at the mug price', () => {
    // 75 mugs + 4 jugs = 91 cups
    expect(kegFinishSummary(keg, 75 * 500 + 4 * 2000, 0, 120)).toEqual({
      expected_cups: 100,
      recorded_cups: 91,
      short_cups: 9,
      short_value_kes: 1080,
    });
  });

  it('R-KEG-3 takes the foam allowance off, and is never negative', () => {
    expect(kegFinishSummary(keg, 45500, 4, 120).short_cups).toBe(5);
    expect(kegFinishSummary(keg, 50000, 4, 120).short_cups).toBe(0);
  });

  it('R-KEG-1 the next keg is the oldest one queued for that product', () => {
    const kegs = [
      { product_id: 'keg', status: 'finished' as const, code: 'K-07' },
      { product_id: 'keg', status: 'queued' as const, code: 'K-10' },
      { product_id: 'keg', status: 'queued' as const, code: 'K-09' },
      { product_id: 'other', status: 'queued' as const, code: 'K-01' },
    ];
    expect(nextQueuedKeg(kegs, 'keg')?.code).toBe('K-09');
    expect(nextQueuedKeg(kegs, 'none')).toBeUndefined();
  });
});
