// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { call, freshDb, pairAs, signInAs } from './testDb';

let pg: PGlite;
let token: string;

beforeEach(async () => {
  pg = await freshDb();
  token = await pairAs(pg, 'd_counter2', 'Counter 2');
  await signInAs(pg, 'p_njeri');
});
afterEach(() => pg.close());

describe('deleting a phone', () => {
  it('revokes it and marks it deleted; the row stays and the phone is shut out', async () => {
    const result = await call<{ results: { status: string }[] }>(pg, "select public.admin_push('bar_baraka', $1::jsonb) as r", [
      JSON.stringify([{ id: 'ae_del', type: 'device_deleted', payload: { device_id: 'd_counter2' }, created_at: new Date().toISOString() }]),
    ]);
    expect(result.results[0]!.status).toBe('applied');
    const row = (await pg.query<any>(`select revoked_at, revoked_reason, deleted_at from public.devices where id = 'd_counter2'`)).rows[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.deleted_at).not.toBeNull();
    expect(row.revoked_reason).toBe('Deleted');
    expect(await call(pg, 'select public.sync_pull($1, $2) as r', [token, null])).toEqual({ error: 'revoked_device' });
  });
});

describe('closing a shift for someone', () => {
  const close = (payload: object) =>
    call<{ results: { status: string }[] }>(pg, "select public.admin_push('bar_baraka', $1::jsonb) as r", [
      JSON.stringify([{ id: `ae_${Math.random().toString(36).slice(2)}`, type: 'shift_closed_by_admin', payload, created_at: new Date().toISOString() }]),
    ]);
  async function openShift() {
    await pg.query(`insert into public.shifts (id, person_id, device_id, opened_at, float_kes, expenses, closed_at, counted_cash_kes, result_kes, cash_baseline_kes, mpesa_baseline_kes)
                    values ('s_left', 'p_kiprop', 'd_counter2', now() - interval '3 hours', 1000, '[]', null, null, null, 0, 0)`);
  }

  it('closes an open shift with the count, as the counter would', async () => {
    await openShift();
    const r = await close({ shift_id: 's_left', person_id: 'p_kiprop', counted_cash_kes: 4800, expected_cash_kes: 5000, result_kes: -200 });
    expect(r.results[0]!.status).toBe('applied');
    const s = (await pg.query<any>(`select closed_at, counted_cash_kes, result_kes from public.shifts where id = 's_left'`)).rows[0];
    expect(s.closed_at).not.toBeNull();
    expect(s).toMatchObject({ counted_cash_kes: 4800, result_kes: -200 });
  });

  it('leaves a shift the counter already closed as it was, and refuses a bad count', async () => {
    await openShift();
    await pg.query(`update public.shifts set closed_at = now(), counted_cash_kes = 5000, result_kes = 0 where id = 's_left'`);
    await close({ shift_id: 's_left', person_id: 'p_kiprop', counted_cash_kes: 1, expected_cash_kes: 5000, result_kes: -4999 });
    expect((await pg.query<any>(`select counted_cash_kes from public.shifts where id = 's_left'`)).rows[0].counted_cash_kes).toBe(5000);
    const bad = await close({ shift_id: 's_left', person_id: 'p_kiprop', counted_cash_kes: -5, expected_cash_kes: 0, result_kes: -5 });
    expect(bad.results[0]!.status).not.toBe('applied');
  });
});
