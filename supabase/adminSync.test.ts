// @vitest-environment node
// The admin's local store (IndexedDB via fake-indexeddb) syncing with the real
// migrations (PGlite), and a counter phone seeing what the admin decided.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { AdminSync, applyAdminPull } from '../src/admin/server';
import { recordAdminEvent } from '../src/data/adminEvents';
import { KauntaDB } from '../src/data/db';
import { hashResetCode } from '../src/domain/pin';
import { call, freshDb, signInAs } from './testDb';

/** admin_push / admin_pull, called as the signed-in admin instead of over HTTP. */
const server = (pg: PGlite) => ({
  push: (events: object[]) => call<any>(pg, "select public.admin_push('bar_baraka', $1::jsonb) as r", [JSON.stringify(events)]),
  pull: (since: string | null) => call<any>(pg, "select public.admin_pull('bar_baraka', $1) as r", [since]),
});

let pg: PGlite;
let db: KauntaDB;
let n = 0;
const ctx = { person_id: 'p_njeri' };

beforeEach(async () => {
  pg = await freshDb();
  await signInAs(pg, 'p_njeri');
  db = new KauntaDB(`kaunta-admin-sync-${++n}`);
  await applyAdminPull(db, await server(pg).pull(null));
});
afterEach(async () => {
  await db.delete();
  await pg.close();
});

const sync = () => new AdminSync(db, server(pg), 60_000);

describe('admin store ⇄ server', () => {
  it('the first pull fills the store the screens read', async () => {
    expect(await db.people.count()).toBe(8);
    expect(await db.orders.where('status').equals('open').count()).toBe(5);
    expect((await db.meta.get('me'))!.value).toBe('p_njeri');
    // Postgres instants come back in the one ISO form the app compares.
    expect((await db.devices.get('d_counter1'))!.paired_at).toMatch(/\.\d{3}Z$/);
  });

  it('a change made on the admin screen reaches the server, and comes back marked synced', async () => {
    const s = sync();
    await recordAdminEvent(db, ctx, { type: 'shelf_counted', payload: { product_id: 'pilsner', counted_qty: 6, before_qty: -4 } });
    await s.run();
    s.stop();
    expect((await pg.query<{ stock_qty: number }>(`select stock_qty from public.products where id = 'pilsner'`)).rows[0]!.stock_qty).toBe(6);
    const entry = (await db.adminOutbox.toArray())[0]!;
    expect(entry.status).toBe('sent');
    expect((await db.auditEvents.get(entry.id))!.synced_at).not.toBeNull();
  });

  it('a product saved in the editor is the same product on the server', async () => {
    const s = sync();
    const product = (await db.products.get('tusker'))!;
    const sizes = await db.sizes.where('product_id').equals('tusker').toArray();
    await recordAdminEvent(db, ctx, {
      type: 'product_saved',
      payload: { product: { ...product, manual_out_of_stock: true }, sizes: sizes.map((x) => ({ ...x, price_kes: 320 })), before: { product, sizes } },
    });
    await s.run();
    s.stop();
    const row = (await pg.query<any>(`select p.manual_out_of_stock, s.price_kes from public.products p join public.sizes s on s.product_id = p.id where p.id = 'tusker'`)).rows[0];
    expect(row).toEqual({ manual_out_of_stock: true, price_kes: 320 });
  });

  it('a change the server refuses is marked, and the store is re-pulled from the server', async () => {
    await pg.query(`insert into public.approvals (id, kind, target, amount_kes, reason_code, requested_by, device_id, requested_at)
      values ('a1', 'void', '{"order_id":"o_039","line_ids":["o_039_l0"],"whole_order":false}', 330, 'changed', 'p_otieno', 'd_counter1', now())`);
    const s = sync();
    await s.run();
    // Another admin decides first, on the server.
    await pg.query(`update public.approvals set status = 'rejected', decided_by = 'p_chebet', decided_at = now() where id = 'a1'`);
    await db.approvals.update('a1', { status: 'waiting' });
    await recordAdminEvent(db, ctx, { type: 'approval_decided', payload: { approval_id: 'a1', decision: 'approved', decided_at: new Date().toISOString() } });
    await s.run();
    await s.run();
    s.stop();
    expect((await db.adminOutbox.toArray()).at(-1)).toMatchObject({ status: 'needs_review', review_reason: 'already_decided' });
    expect(s.lastRejected).toBe('already_decided');
    expect((await db.approvals.get('a1'))).toMatchObject({ status: 'rejected', decided_by: 'p_chebet' });
  });

  it('a PIN reset made in admin is what a counter verifies the code against (R-PIN-2)', async () => {
    const s = sync();
    const reset_hash = await hashResetCode('482913');
    await recordAdminEvent(db, ctx, { type: 'pin_reset', payload: { person_id: 'p_otieno', reset_hash, expires_at: new Date(Date.now() + 86_400_000).toISOString() } });
    await s.run();
    s.stop();
    const row = (await pg.query<{ pin_reset_hash: string }>(`select pin_reset_hash from public.people where id = 'p_otieno'`)).rows[0]!;
    expect(row.pin_reset_hash).toBe(reset_hash);
  });

  it('a delivery with a keg: stock, delivery and queued keg on the server', async () => {
    const s = sync();
    await recordAdminEvent(db, ctx, {
      type: 'delivery_recorded',
      payload: {
        delivery: { id: 'dl1', supplier: null, note_no: 'DN-9', received_by: 'p_njeri', created_at: new Date().toISOString(), keg_ids: ['k10'],
          lines: [{ product_id: 'cane', container_label: '750ml bottle', container_qty: 3, per_container: 750, total: 2250 }] },
        kegs: [{ id: 'k10', product_id: 'keg', code: 'K-10', volume_ml: 50000, cup_ml: 500, status: 'queued', tapped_at: null, finished_at: null, finished_by: null, recorded_ml_baseline: 0 }],
      },
    });
    await s.run();
    s.stop();
    expect((await pg.query<any>(`select stock_qty from public.products where id = 'cane'`)).rows[0].stock_qty).toBe(4850 + 2250);
    expect((await pg.query<any>(`select status from public.kegs where id = 'k10'`)).rows[0].status).toBe('queued');
    expect((await db.deliveries.get('dl1'))!.note_no).toBe('DN-9');
  });
});
