import { hashPin } from '../src/domain/pin';
import { loadSeed } from '../src/domain/seed';

/** A fixed salt per person, so the generated seed file is the same every time. */
async function seedSalt(personId: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`kaunta-seed:${personId}`));
  return new Uint8Array(digest).slice(0, 16);
}

const SEEDED_AT = '2026-11-10T00:00:00.000Z';

function insert(table: string, rows: readonly object[], defaults: Record<string, unknown> = {}): string {
  const json = JSON.stringify(rows.map((row) => ({ ...defaults, ...row, updated_at: SEEDED_AT })), null, 1);
  if (json.includes('$seed$')) throw new Error('seed data contains the quoting delimiter');
  return `insert into public.${table}\nselect * from jsonb_populate_recordset(null::public.${table}, $seed$${json}$seed$);\n`;
}

/**
 * supabase/seed.sql: the handoff sample data (Baraka Pub, 10 Nov 2026) for a
 * new Supabase project, built from the same loadSeed() the app uses. Demo
 * PINs are stored only as salted hashes. Devices carry no token: pair a phone
 * with create_pairing_code(...) (see supabase/README.md).
 */
export async function buildSeedSql(): Promise<string> {
  const seed = loadSeed();
  const people = await Promise.all(
    seed.people.map(async (person) => ({
      ...person,
      pin_hash: seed.demoPins[person.id] ? await hashPin(seed.demoPins[person.id]!, await seedSalt(person.id)) : null,
      // The sample day's lock is a fixed moment in the past; start unlocked.
      pin_locked_until: null,
      failed_pin_attempts: 0,
    })),
  );
  return [
    '-- Generated from kaunta-handoff/data/seed.json by supabase/seedSql.ts. Do not edit by hand:',
    '-- run `npm run seed:sql` after changing the seed, and `npm test` checks the two agree.',
    '',
    insert('bar', [seed.bar]),
    insert('categories', seed.categories),
    insert('people', people),
    insert('devices', seed.devices, { token_hash: null, last_sync_at: null }),
    insert('products', seed.products, { sort: 0 }),
    insert('sizes', seed.sizes),
    insert('kegs', seed.kegs),
    insert('orders', seed.orders, { handover_pending: false }),
    insert('lines', seed.lines),
    insert('payments', seed.payments),
    insert('shifts', seed.shifts),
  ].join('\n');
}
