import { describe, expect, it } from 'vitest';
import { daySales, inFilter, shiftSales } from './shiftSales';
import type { ApprovalItem, Order, OrderLine, Payment, Shift } from './types';

const shift: Shift = {
  id: 's1', person_id: 'me', device_id: 'd1', opened_at: '2026-11-23T15:00:00.000Z', float_kes: 0, expenses: [],
  closed_at: null, counted_cash_kes: null, result_kes: null, cash_baseline_kes: 0, mpesa_baseline_kes: 0,
};
const rec = { device_id: 'd1', synced_at: null };
const order = (id: string, over: Partial<Order> = {}): Order => ({
  ...rec, id, short_no: `#${id}`, short_no_provisional: false, label: 'Counter', server_id: 'me', recorded_by: 'me',
  business_day: '2026-11-23', status: 'open', handed_over_to: null, created_at: '2026-11-23T16:00:00.000Z', ...over,
});
const line = (id: string, order_id: string, status: OrderLine['status'] = 'active'): OrderLine => ({
  ...rec, id, order_id, product_id: 'p', size_id: 'z', qty: 1, unit_price_kes: 300, status, keg_id: null,
  recorded_by: 'me', created_at: '2026-11-23T16:00:00.000Z',
});
const pay = (order_id: string, amount_kes: number): Payment => ({
  ...rec, id: `pay-${order_id}`, order_id, method: 'cash', amount_kes, mpesa_ref_last4: null, recorded_by: 'me', created_at: '2026-11-23T16:05:00.000Z',
});
const approval = (order_id: string, status: ApprovalItem['status'], at = '2026-11-23T16:10:00.000Z'): ApprovalItem => ({
  id: `a-${order_id}-${status}`, kind: 'void', target: { order_id, line_ids: [], whole_order: false }, amount_kes: 300, reason_code: 'mistake',
  requested_by: 'me', device_id: 'd1', requested_at: at, status, decided_by: status === 'waiting' ? null : 'boss', decided_at: null,
});

describe('shiftSales', () => {
  const orders = [
    order('open'),
    order('paid', { status: 'paid', created_at: '2026-11-23T16:30:00.000Z' }),
    order('voided', { status: 'voided', created_at: '2026-11-23T16:20:00.000Z' }),
    order('asked', { created_at: '2026-11-23T16:40:00.000Z' }),
    order('before', { created_at: '2026-11-23T14:00:00.000Z' }),
    order('other', { server_id: 'x', recorded_by: 'x' }),
    order('otherPhone', { device_id: 'd2' }),
    order('handed', { server_id: 'x', recorded_by: 'x', created_at: '2026-11-23T12:00:00.000Z', handed_over_to: 'me' }),
  ];
  const lines = [
    line('l1', 'open'), line('l2', 'paid'), line('l3', 'voided', 'voided'), line('l4', 'asked'), line('l5', 'asked', 'void_pending'),
  ];
  const sales = shiftSales(shift, 'me', orders, lines, [pay('paid', 300), pay('open', 100)], [
    approval('asked', 'rejected', '2026-11-23T16:41:00.000Z'),
    approval('asked', 'waiting', '2026-11-23T16:45:00.000Z'),
    approval('open', 'cancelled'),
  ]);
  const byId = Object.fromEntries(sales.map((s) => [s.order.id, s]));

  it('keeps this person’s orders on this phone since the shift opened, and orders handed to them; newest first', () => {
    expect(sales.map((s) => s.order.id)).toEqual(['asked', 'paid', 'voided', 'open', 'handed']);
  });

  it('works out what is due, paid and voided', () => {
    expect(byId.open).toMatchObject({ total: 300, paid: 100, due: 200, voided_kes: 0, void: null });
    expect(byId.paid).toMatchObject({ total: 300, paid: 300, due: 0 });
    expect(byId.voided).toMatchObject({ total: 0, voided_kes: 300, void: { kind: 'self' } });
  });

  it('shows the latest void request that was not taken back', () => {
    expect(byId.asked!.void).toEqual({ kind: 'approval', status: 'waiting', decided_by: null });
    expect(byId.open!.void).toBeNull();
  });

  it('filters', () => {
    const ids = (f: Parameters<typeof inFilter>[1]) => sales.filter((s) => inFilter(s, f)).map((s) => s.order.id);
    expect(ids('pending')).toEqual(['asked', 'open', 'handed']);
    expect(ids('paid')).toEqual(['paid']);
    expect(ids('cancelled')).toEqual(['asked', 'voided']);
    expect(ids('all')).toHaveLength(5);
  });
});

describe('daySales', () => {
  const orders = [
    order('mine9', { business_day: '2026-11-22', created_at: '2026-11-22T17:00:00.000Z' }),
    order('otherPhone9', { business_day: '2026-11-22', device_id: 'd2', created_at: '2026-11-22T18:00:00.000Z' }),
    order('handedAway9', { business_day: '2026-11-22', handed_over_to: 'x' }),
    order('handedToMe9', { business_day: '2026-11-22', server_id: 'x', recorded_by: 'x', handed_over_to: 'me' }),
    order('notMine9', { business_day: '2026-11-22', server_id: 'x', recorded_by: 'x' }),
    order('today'),
  ];
  it('keeps this person’s orders on that business day from any phone, handed over ones going with the handover', () => {
    expect(daySales('2026-11-22', 'me', orders, [], [], []).map((s) => s.order.id)).toEqual(['handedToMe9', 'otherPhone9', 'mine9']);
  });
});
