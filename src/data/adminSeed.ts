import { hashPin } from '../domain/pin';
import { loadSampleDay, SAMPLE_NOW } from '../domain/sampleDay';
import { loadSeed } from '../domain/seed';
import type { SampleDay } from '../domain/sampleDay';
import type { KauntaDB } from './db';

/**
 * Fills an empty admin store with the sample business day (demo mode, no
 * server). Does nothing if it was filled before, so admin changes survive a
 * reload.
 *
 * The demo runs on its own clock: it starts at 02:14 on the sample night (the
 * designs' "now") and then moves at real speed, so countdowns and "now" work.
 * `demoNow` reads it back.
 */
export async function seedAdminDatabase(db: KauntaDB, options: { day?: SampleDay; now?: Date } = {}): Promise<boolean> {
  if (await db.meta.get('seeded')) return false;
  const day = options.day ?? loadSampleDay();
  const realNow = options.now ?? new Date();
  const offset = Date.parse(SAMPLE_NOW) - realNow.getTime();
  // Otieno's lock, as the Staff design shows it: 4:52 still to go.
  const lockUntil = new Date(Date.parse(SAMPLE_NOW) + (4 * 60 + 52) * 1000).toISOString();
  // Counter staff's demo PINs, which owners and managers can look up (hashed before the transaction: WebCrypto would end it).
  const pins = loadSeed().demoPins;
  const hashes = new Map<string, string>();
  for (const [id, pin] of Object.entries(pins)) hashes.set(id, await hashPin(pin));
  const people = day.people.map((p) => ({
    ...p,
    ...(pins[p.id] ? { pin_code: pins[p.id], pin_hash: hashes.get(p.id)! } : {}),
    ...(p.pin_locked_until ? { pin_locked_until: lockUntil } : {}),
  }));

  return db.transaction('rw', db.tables, async () => {
    if (await db.meta.get('seeded')) return false;
    await db.bar.add(day.bar);
    await db.categories.bulkAdd(day.categories);
    // Put, not add: an owner's or manager's row may be here already (ensureMemberPeople ran first); it is put right again after seeding.
    await db.people.bulkPut(people);
    await db.devices.bulkAdd(
      day.devices.map((d) => ({ ...d, last_sync_at: d.revoked_at ? d.revoked_at : new Date(Date.parse(SAMPLE_NOW) - 60_000).toISOString() })),
    );
    await db.products.bulkAdd(day.products);
    await db.sizes.bulkAdd(day.sizes);
    await db.kegs.bulkAdd(day.kegs);
    await db.orders.bulkAdd(day.orders);
    await db.lines.bulkAdd(day.lines);
    await db.payments.bulkAdd(day.payments);
    await db.shifts.bulkAdd(day.shifts);
    await db.approvals.bulkAdd(day.approvals);
    await db.deliveries.bulkAdd(day.deliveries);
    await db.stockMovements.bulkAdd(day.stockMovements);
    await db.auditEvents.bulkAdd(day.auditEvents);
    await db.meta.bulkAdd([
      { key: 'seeded', value: realNow.toISOString() },
      { key: 'clock_offset_ms', value: offset },
    ]);
    return true;
  });
}

/** The demo's clock offset from real time (0 when not a demo). */
export async function clockOffset(db: KauntaDB): Promise<number> {
  const row = await db.meta.get('clock_offset_ms');
  return typeof row?.value === 'number' ? row.value : 0;
}
