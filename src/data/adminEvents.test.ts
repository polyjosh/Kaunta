import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orderDue, orderTotal } from '../domain/orders';
import { SAMPLE_NOW } from '../domain/sampleDay';
import { approvalEffect, recordAdminEvent, UNDO_GRACE_MS } from './adminEvents';
import type { AdminContext } from './adminEvents';
import { seedAdminDatabase } from './adminSeed';
import { KauntaDB } from './db';

let db: KauntaDB;
let n = 0;
let clock = Date.parse(SAMPLE_NOW);
const njeri: AdminContext = { person_id: 'p_njeri', now: () => new Date(clock) };
const decide = (approval_id: string, decision: 'approved' | 'rejected') =>
  recordAdminEvent(db, njeri, { type: 'approval_decided', payload: { approval_id, decision, decided_at: new Date(clock).toISOString() } });
const stock = async (id: string) => (await db.products.get(id))!.stock_qty;

beforeEach(async () => {
  clock = Date.parse(SAMPLE_NOW);
  db = new KauntaDB(`kaunta-admin-test-${++n}`);
  await seedAdminDatabase(db, { now: new Date(SAMPLE_NOW) });
});
afterEach(() => db.delete());

describe('recordAdminEvent', () => {
  it('applies, audits and queues in one go', async () => {
    const entry = await decide('a_void_039', 'approved');
    expect(entry.status).toBe('pending');
    expect(await db.adminOutbox.count()).toBe(1);
    const audit = await db.auditEvents.get(entry.id);
    expect(audit).toMatchObject({ kind: 'approval_decided', actor_id: 'p_njeri', ref_id: 'a_void_039', synced_at: null });
  });

  it('an event that cannot apply leaves nothing behind', async () => {
    await decide('a_void_039', 'approved');
    await expect(decide('a_void_039', 'approved')).rejects.toThrow('Already decided');
    expect(await db.adminOutbox.count()).toBe(1);
  });
});

describe('approvals (R-VOID-2…4, R-COMP-1)', () => {
  it('approved void: KES 330 off #039, 1 Guinness back in stock', async () => {
    const before = await stock('guinness');
    await decide('a_void_039', 'approved');
    const lines = await db.lines.where('order_id').equals('o_039').toArray();
    expect(orderTotal(lines)).toBe(1_480 - 330);
    expect(await stock('guinness')).toBe(before! + 1);
    expect((await db.approvals.get('a_void_039'))).toMatchObject({ status: 'approved', decided_by: 'p_njeri' });
  });

  it('rejected void: the line stands and still counts', async () => {
    await decide('a_void_039', 'rejected');
    const line = (await db.lines.where('order_id').equals('o_039').toArray()).find((l) => l.size_id === 'guinness_0')!;
    expect(line.status).toBe('active');
  });

  it('approved whole-order void cancels #041 and returns its stock (ml for the Cane)', async () => {
    const [tusker, cane] = [await stock('tusker'), await stock('cane')];
    await decide('a_void_041', 'approved');
    expect((await db.orders.get('o_041'))!.status).toBe('voided');
    expect(await stock('tusker')).toBe(tusker! + 3);
    expect(await stock('cane')).toBe(cane! + 350);
  });

  it('write-off: approving keeps the loss; rejecting puts the 2 bottles back to be found', async () => {
    const tusker = await stock('tusker');
    await decide('a_wo_tusker', 'approved');
    expect(await stock('tusker')).toBe(tusker);
    await db.approvals.update('a_wo_tusker', { status: 'waiting', decided_at: null });
    await decide('a_wo_tusker', 'rejected');
    expect(await stock('tusker')).toBe(tusker! + 2);
  });

  it('comp: approving takes the tot (30 ml) out of stock', async () => {
    const cane = await stock('cane');
    await decide('a_comp_046', 'approved');
    expect(await stock('cane')).toBe(cane! - 30);
  });

  it('price mismatch: either way the sale stays as recorded', () => {
    expect(approvalEffect({ kind: 'price_mismatch', target: { order_id: 'o', line_ids: ['l'], whole_order: false } }, 'rejected', [])).toEqual({ lines: null, stock: [] });
  });

  it('undo inside the grace period reverses exactly; after it the decision is final', async () => {
    const guinness = await stock('guinness');
    await decide('a_void_039', 'approved');
    clock += 30_000;
    await recordAdminEvent(db, njeri, { type: 'approval_undone', payload: { approval_id: 'a_void_039' } });
    expect(await stock('guinness')).toBe(guinness);
    expect((await db.approvals.get('a_void_039'))!.status).toBe('waiting');
    const line = (await db.lines.where('order_id').equals('o_039').toArray()).find((l) => l.size_id === 'guinness_0')!;
    expect(line.status).toBe('void_pending');
    expect(orderDue(await db.lines.where('order_id').equals('o_039').toArray(), [])).toBe(1_480);

    await decide('a_void_039', 'approved');
    clock += UNDO_GRACE_MS + 1;
    await expect(recordAdminEvent(db, njeri, { type: 'approval_undone', payload: { approval_id: 'a_void_039' } })).rejects.toThrow('final');
  });
});

describe('stock (R-STOCK-2…4)', () => {
  it('a delivery adds containers × size; a keg goes to the queue, not the shelf', async () => {
    const cane = await stock('cane');
    await recordAdminEvent(db, njeri, {
      type: 'delivery_recorded',
      payload: {
        delivery: {
          id: 'dl_1', supplier: null, note_no: null, received_by: 'p_njeri', created_at: SAMPLE_NOW, keg_ids: ['k10'],
          lines: [
            { product_id: 'cane', container_label: 'Bottle 750 ml', container_qty: 3, per_container: 750, total: 2_250 },
            { product_id: 'pilsner', container_label: 'Crate of 25', container_qty: 1, per_container: 25, total: 25 },
          ],
        },
        kegs: [{ id: 'k10', product_id: 'keg', code: 'K-10', volume_ml: 50_000, cup_ml: 500, status: 'queued', tapped_at: null, finished_at: null, finished_by: null, recorded_ml_baseline: 0 }],
      },
    });
    expect(await stock('cane')).toBe(cane! + 2_250);
    expect(await stock('pilsner')).toBe(21);
    expect((await db.kegs.get('k10'))!.status).toBe('queued');
  });

  it('a shelf count sets the stock and records the difference', async () => {
    await recordAdminEvent(db, njeri, { type: 'shelf_counted', payload: { product_id: 'pilsner', counted_qty: 2, before_qty: -4 } });
    expect(await stock('pilsner')).toBe(2);
    const moves = await db.stockMovements.where('product_id').equals('pilsner').toArray();
    expect(moves.map((m) => [m.reason, m.delta])).toEqual([['count', 6]]);
  });
});

describe('kegs, staff, devices, day close', () => {
  it('keg finished puts the next on tap (R-KEG-1)', async () => {
    await recordAdminEvent(db, njeri, { type: 'keg_finished', payload: { keg_id: 'k08', finished_at: SAMPLE_NOW, next_keg_id: 'k09' } });
    expect((await db.kegs.get('k08'))!.status).toBe('finished');
    expect((await db.kegs.get('k09'))).toMatchObject({ status: 'active', tapped_at: SAMPLE_NOW });
  });

  it('unlock, archive, revoke, close the day', async () => {
    await recordAdminEvent(db, njeri, { type: 'person_unlocked', payload: { person_id: 'p_otieno' } });
    expect(await db.people.get('p_otieno')).toMatchObject({ pin_locked_until: null, failed_pin_attempts: 0 });
    await recordAdminEvent(db, njeri, { type: 'device_revoked', payload: { device_id: 'd_counter2', reason: 'Phone lost' } });
    expect((await db.devices.get('d_counter2'))!.revoked_reason).toBe('Phone lost');
    await recordAdminEvent(db, njeri, {
      type: 'day_closed',
      payload: { day_close: { business_day: '2026-11-10', till_total_kes: 47_650, recorded_mpesa_kes: 48_400, closed_by: 'p_njeri', closed_at: SAMPLE_NOW } },
    });
    expect((await db.dayCloses.get('2026-11-10'))!.till_total_kes).toBe(47_650);
  });
});
