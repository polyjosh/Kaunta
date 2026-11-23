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
