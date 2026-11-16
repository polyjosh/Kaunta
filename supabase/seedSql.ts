import { hashPin } from '../src/domain/pin';
import { SAMPLE_BAR_CODE } from '../src/domain/barCode';
import { loadSeed } from '../src/domain/seed';

/** A fixed salt per person, so the generated seed file is the same every time. */
async function seedSalt(personId: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`kaunta-seed:${personId}`));
  return new Uint8Array(digest).slice(0, 16);
}

const SEEDED_AT = '2026-11-10T00:00:00.000Z';

function insert(table: string, rows: readonly object[], defaults: Record<string, unknown> = {}, onConflict = ''): string {
  const json = JSON.stringify(rows.map((row) => ({ ...defaults, ...row, updated_at: SEEDED_AT })), null, 1);
  if (json.includes('$seed$')) throw new Error('seed data contains the quoting delimiter');
  return `insert into public.${table}\nselect * from jsonb_populate_recordset(null::public.${table}, $seed$${json}$seed$)${onConflict};\n`;
}

/**
 * supabase/seed.sql: the handoff sample data (Baraka Pub, 10 Nov 2026) for a
 * new Supabase project, built from the same loadSeed() the app uses. Demo
 * PINs are stored as salted hashes (for the counter) and as the digits, which
 * only admins can read. Devices carry no token: pair a phone
 * with create_pairing_code(...) (see supabase/README.md).
 */
export async function buildSeedSql(): Promise<string> {
  const seed = loadSeed();
  const people = await Promise.all(
    seed.people.map(async (person) => ({
      ...person,
      pin_hash: seed.demoPins[person.id] ? await hashPin(seed.demoPins[person.id]!, await seedSalt(person.id)) : null,
      // Owners and managers can look counter staff's PINs up (never sent to counter phones).
      pin_code: seed.demoPins[person.id] ?? null,
      // The sample day's lock is a fixed moment in the past; start unlocked.
      pin_locked_until: null,
      failed_pin_attempts: 0,
    })),
  );
  // Every bar-scoped row names the sample bar, so the seed also loads into a project that already runs other bars.
  const bar_id = seed.bar.id;
  return [
    '-- Generated from kaunta-handoff/data/seed.json by supabase/seedSql.ts. Do not edit by hand:',
    '-- run `npm run seed:sql` after changing the seed, and `npm test` checks the two agree.',
    '',
    insert('bar', [{ ...seed.bar, counter_code: SAMPLE_BAR_CODE }]),
    // The categories migration already inserted these; the seed's copy wins.
    insert('categories', seed.categories, {}, '\non conflict (id) do update set name_en = excluded.name_en, name_sw = excluded.name_sw, sort = excluded.sort, updated_at = excluded.updated_at'),
    insert('people', people, { bar_id }),
    insert('devices', seed.devices, { bar_id, token_hash: null, last_sync_at: null }),
    insert('products', seed.products, { bar_id, sort: 0 }),
    insert('sizes', seed.sizes, { bar_id }),
    insert('kegs', seed.kegs, { bar_id }),
    insert('orders', seed.orders, { bar_id, handover_pending: false }),
    insert('lines', seed.lines, { bar_id }),
    insert('payments', seed.payments, { bar_id }),
    insert('shifts', seed.shifts, { bar_id }),
  ].join('\n');
}
