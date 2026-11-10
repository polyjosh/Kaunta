import { hashPin } from '../domain/pin';
import { loadSeed } from '../domain/seed';
import type { SeedData } from '../domain/seed';
import type { Id } from '../domain/types';
import type { KauntaDB } from './db';

interface SeedOptions {
  seed?: SeedData;
  /** Which seeded device this phone is, until pairing exists (build step 5). */
  device_id?: Id;
  now?: Date;
}

/**
 * Fills an empty local store with the handoff sample data. Does nothing if
 * the store was already seeded, so it never overwrites what staff recorded.
 * Seed records count as already synced; the outbox starts empty.
 *
 * Two things are adapted for a running demo: demo PINs are stored as hashes,
 * and a seeded PIN lock (a fixed moment in the sample day) is restarted from
 * `now`, showing the designed 4:52 instead of a lock long past or hours away.
 */
export async function seedDatabase(db: KauntaDB, options: SeedOptions = {}): Promise<boolean> {
  if (await db.meta.get('seeded')) {
    // A store seeded by an earlier build gets what was added since: the sample
    // shifts, and the counter order of products. Nothing recorded is touched.
    if (!(await db.meta.get('seeded_shifts'))) {
      const { shifts, products } = options.seed ?? loadSeed();
      await db.transaction('rw', db.shifts, db.products, db.meta, async () => {
        await db.shifts.bulkPut(shifts);
        for (const product of products) await db.products.update(product.id, { sort: product.sort });
        await db.meta.put({ key: 'seeded_shifts', value: true });
      });
    }
    return false;
  }
  const seed = options.seed ?? loadSeed();
  const now = options.now ?? new Date();

  // Hash before opening the transaction: WebCrypto would end it.
  const hashes = new Map<Id, string>();
  for (const [personId, pin] of Object.entries(seed.demoPins)) hashes.set(personId, await hashPin(pin));
  const demoLock = new Date(now.getTime() + (4 * 60 + 52) * 1000).toISOString();
  const people = seed.people.map((person) => ({
    ...person,
    pin_hash: hashes.get(person.id) ?? null,
    pin_locked_until: person.pin_locked_until ? demoLock : null,
    failed_pin_attempts: person.pin_locked_until ? seed.bar.pin_attempts : 0,
  }));

  return db.transaction('rw', db.tables, async () => {
    if (await db.meta.get('seeded')) return false;
    await db.bar.add(seed.bar);
    await db.categories.bulkAdd(seed.categories);
    await db.people.bulkAdd(people);
    await db.devices.bulkAdd(seed.devices);
    await db.products.bulkAdd(seed.products);
    await db.sizes.bulkAdd(seed.sizes);
    await db.kegs.bulkAdd(seed.kegs);
    await db.orders.bulkAdd(seed.orders);
    await db.lines.bulkAdd(seed.lines);
    await db.payments.bulkAdd(seed.payments);
    await db.shifts.bulkAdd(seed.shifts);
    await db.meta.bulkAdd([
      { key: 'seeded', value: now.toISOString() },
      { key: 'seeded_shifts', value: true },
      // The sample data arrives as already synced.
      { key: 'last_sync_at', value: now.toISOString() },
      { key: 'device_id', value: options.device_id ?? 'd_counter1' },
    ]);
    return true;
  });
}
