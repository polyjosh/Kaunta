// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { call, freshDb, pairAs, signInAs } from './testDb';

let pg: PGlite;
let token: string;
let n = 0;
const id = (prefix: string) => `${prefix}_${++n}_${Math.random().toString(36).slice(2, 8)}`;
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const one = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0]!;

const counter = (type: string, payload: object) => ({ id: id('ev'), type, payload, recorded_by: 'p_kiprop', device_id: 'd_counter1', created_at: at() });
const push = async (events: object[]) =>
  (await call<{ results: { status: string; reason: string | null }[] }>(pg, 'select public.sync_push($1, $2::jsonb) as r', [token, JSON.stringify(events)])).results;
const admin = async (type: string, payload: object) =>
  (await call<{ results: { status: string; reason: string | null }[] }>(pg, "select public.admin_push('bar_baraka', $1::jsonb) as r", [
    JSON.stringify([{ id: id('ae'), type, payload, created_at: at() }]),
  ])).results[0]!;

beforeEach(async () => {
  pg = await freshDb();
  token = await pairAs(pg);
  await signInAs(pg, 'p_njeri');
});
afterEach(() => pg.close());

async function openShift() {
  const shiftId = id('s');
  await push([
    counter('shift_opened', {
      shift: { id: shiftId, person_id: 'p_kiprop', device_id: 'd_counter1', opened_at: at(), float_kes: 1000, expenses: [], closed_at: null, counted_cash_kes: null, result_kes: null, cash_baseline_kes: 0, mpesa_baseline_kes: 0 },
    }),
  ]);
  return shiftId;
}

const expenseEvent = (shiftId: string, over: object = {}) => {
  const expense = { id: id('x'), label: 'Ice', amount_kes: 300, paid_from: 'cash', at: at(), ...over };
  // What the phone sends; the server builds the approval itself from the expense.
  const approval = { id: id('a'), kind: 'void', amount_kes: 1, requested_by: 'someone_else', status: 'approved' };
  return { expense, approval, ev: counter('shift_expense_added', { shift_id: shiftId, expense, approval }) };
};

describe('expenses go to Approvals', () => {
  it('an expense becomes a waiting approval, built from the expense, which admin can reject', async () => {
    const shiftId = await openShift();
    const { expense, approval, ev } = expenseEvent(shiftId);
    expect((await push([ev]))[0]!.status).toBe('applied');
    const row = await one('select kind, status, amount_kes, reason_code, requested_by, target, detail from public.approvals where id = $1', [approval.id]);
    expect(row).toMatchObject({ kind: 'expense', status: 'waiting', amount_kes: 300, reason_code: 'cash', requested_by: 'p_kiprop', detail: { label: 'Ice' } });
    expect(row.target).toMatchObject({ shift_id: shiftId, expense_id: expense.id });

    expect((await admin('approval_decided', { approval_id: approval.id, decision: 'rejected', decided_at: at() })).status).toBe('applied');
    expect((await one('select status from public.approvals where id = $1', [approval.id])).status).toBe('rejected');
    // The phone hears of it with its next pull.
    const pulled = await call<Record<string, any>>(pg, 'select public.sync_pull($1, $2) as r', [token, null]);
    expect(pulled.approvals.find((a: { id: string }) => a.id === approval.id).status).toBe('rejected');
    // Decided: it can no longer be removed at the counter.
    expect((await push([counter('shift_expense_removed', { shift_id: shiftId, expense })]))[0]!.status).toBe('needs_review');
  });

  it('removed before anyone decided: the approval is cancelled and stays cancelled', async () => {
    const shiftId = await openShift();
    const { expense, approval, ev } = expenseEvent(shiftId);
    await push([ev, counter('shift_expense_removed', { shift_id: shiftId, expense })]);
    expect((await one('select status from public.approvals where id = $1', [approval.id])).status).toBe('cancelled');
    expect((await admin('approval_decided', { approval_id: approval.id, decision: 'approved', decided_at: at() })).status).toBe('rejected');
  });
});

describe('paying takes back a void request', () => {
  async function waitingVoid() {
    await pg.query(`update public.lines set status = 'void_pending' where id = 'o_039_l0'`);
    await pg.query(
      `insert into public.approvals (id, kind, target, amount_kes, reason_code, requested_by, device_id, requested_at)
       values ('a1', 'void', '{"order_id":"o_039","line_ids":["o_039_l0"],"whole_order":false}', 330, 'changed', 'p_otieno', 'd_counter1', now())`,
    );
  }

  it('the lines are sold as normal and the request leaves the list', async () => {
    await waitingVoid();
    const [r] = await push([counter('void_request_cancelled', { order_id: 'o_039', approval_ids: ['a1'] })]);
    expect(r!.status).toBe('applied');
    expect(await one("select status from public.lines where id = 'o_039_l0'")).toEqual({ status: 'active' });
    expect(await one("select status from public.approvals where id = 'a1'")).toEqual({ status: 'cancelled' });
    expect((await admin('approval_undone', { approval_id: 'a1' })).status).toBe('rejected');
  });

  it('already decided on the server: the decision stands and the payment is set aside for a look', async () => {
    await waitingVoid();
    await admin('approval_decided', { approval_id: 'a1', decision: 'approved', decided_at: at() });
    const [r] = await push([counter('void_request_cancelled', { order_id: 'o_039', approval_ids: ['a1'] })]);
    expect(r).toMatchObject({ status: 'needs_review', reason: 'void_already_decided' });
    expect(await one("select status from public.lines where id = 'o_039_l0'")).toEqual({ status: 'voided' });
  });

  it('only void requests on that order', async () => {
    await waitingVoid();
    expect((await push([counter('void_request_cancelled', { order_id: 'o_040', approval_ids: ['a1'] })]))[0]!.status).toBe('needs_review');
    expect(await one("select status from public.approvals where id = 'a1'")).toEqual({ status: 'waiting' });
  });
});

describe('the self-void window', () => {
  it('is 2 minutes for new bars and for bars that had the old 5', async () => {
    expect((await one("select self_void_minutes from public.bar where id = 'bar_baraka'")).self_void_minutes).toBe(2);
    await pg.query("insert into public.bar (id, name) values ('bar_new', 'New')");
    expect((await one("select self_void_minutes from public.bar where id = 'bar_new'")).self_void_minutes).toBe(2);
  });
});
