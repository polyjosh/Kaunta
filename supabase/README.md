# Kaunta on Supabase

The server for counter sync (build step 4) and the admin screens (build step 5). Phones never read or write tables
directly: row level security is on with no policies and table grants are
revoked. They call three functions with the public anon key:

| Function | What it does | Rules |
|---|---|---|
| `pair_device(code, name, model)` | Trades a 6-digit pairing code for a device token. 20 wrong codes in 10 minutes stops all pairing for 10 minutes. | R-DEV-1 |
| `sync_push(token, events)` | Applies outbox events in order, idempotently by event id. Assigns final order numbers, moves stock, raises approvals. Never drops an event: what can't be applied is stored as `needs_review`. | R-SYNC-2, R-SYNC-3, R-DAY-2, R-SELL-5, R-DEV-2 |
| `sync_pull(token, since)` | Everything changed since the cursor (open orders and the last two business days). | R-SYNC-4 |

What becomes "needs admin" on the phone:

- **price_mismatch**: the sale's price differs from the server's price at the moment of the sale (an offline phone with a stale price). Kept as recorded; an approval for `(server − recorded) × qty`.
- **archived_product**: sold after the product was archived. Kept; an approval.
- **revoked_device**: sent by a revoked phone. Stored, not applied; an approval.
- **wrong_device**: an event claiming to come from a different phone. Stored, not applied.
- **not_applied**: anything else that failed (for example a payment for an order the server never received). Stored with the error message.

Admins and owners sign in with Supabase Auth (phone or email + password).
Their auth user is linked to a `people` row with role `owner` or `admin`, and
they too only call functions (`20261111000000_kaunta_admin.sql`):

| Function | What it does | Rules |
|---|---|---|
| `admin_pull(since)` | Everything changed since the cursor, for the admin's local store: last 35 business days of sales, approvals, shifts, deliveries, day closes, stock movements, and the audit log with each event's detail. | R-AUD-1 |
| `admin_push(events)` | Applies admin decisions and changes in order, idempotently by id: approvals (with a 2-minute undo), product and price changes, deliveries, shelf counts, kegs, unlock / PIN reset / add / archive people, revoke a phone, close the day. A change that can't apply (say another admin decided first) is answered `rejected` and changes nothing. | R-VOID-2…4, R-COMP-1, R-STOCK-2…4, R-KEG-1…3, R-PIN-1/2, R-DEV-2, R-DAY-3 |
| `admin_create_pairing_code(name)` | A 6-digit code for a new counter phone, recorded as made by that admin. | R-DEV-1 |

Counter phones get one more event, `pin_set`: after an admin's **Reset PIN**,
the person types the one-time code at a counter and chooses a new PIN. Only
salted hashes of the code and the PIN ever leave a device.

## Set up a project

1. Create a project at [supabase.com](https://supabase.com) (any region; `eu-central` or `af-south` are closest to Kenya).
2. In **SQL Editor**, run the migrations in order: `supabase/migrations/20261110000000_kaunta_sync.sql`, then `20261111000000_kaunta_admin.sql`.
3. For the sample data (Baraka Pub, as in the designs), also run `supabase/seed.sql`. Skip it for a real bar.
4. In **Project Settings → API**, copy the Project URL and the `anon` `public` key into `.env.local` (start from `.env.example`). Never use the `service_role` key in the app.
5. Run `npm run dev`. The counter shows **Connect this phone**.
6. In the SQL Editor, make a pairing code (valid 10 minutes, works once):

   ```sql
   select create_pairing_code('Counter 1', 'd_counter1');  -- re-pair the sample "Counter 1"
   select create_pairing_code('Counter 3');                 -- or a brand-new device
   ```

   Type the code on the phone. It pulls the menu, staff and open orders, then shows the staff list.

7. Give the owner an admin sign-in. In **Authentication → Users → Add user**, create a user with the owner's phone number (or email) and a password, and tick *Auto confirm*. Copy the user's id and link it:

   ```sql
   update public.people set auth_user_id = '<the user id>', phone = '+2547…' where id = 'p_njeri';
   ```

   Open `/admin` and sign in. From there, **Staff & devices → Make pairing code** replaces step 6, and other admins are linked the same way.

The sample `seed.sql` is the counter's snapshot (five open orders at 22:20). The admin demo without a server runs on the whole sample night instead (`src/domain/sampleDay.ts`), so Today shows the design's totals there; on a server it shows whatever the counters have recorded.

With the CLI instead: `supabase link` then `supabase db push`, and `psql < supabase/seed.sql` for the sample data.

## Tests

`npm test` runs this migration in PGlite (real Postgres compiled to WebAssembly, no Docker), with Supabase's `anon`/`authenticated`/`service_role` roles created first:

- `supabase/sync.test.ts`: every function, each event type, each conflict rule, and that the anon role cannot read tables or make pairing codes.
- `supabase/phones.test.ts`: real phone stores (IndexedDB) syncing with the database, including two counters and an offline price change.
- `supabase/admin.test.ts`: who may call the admin functions, every admin event, undo, idempotency, a PIN reset reaching a counter, revoking, pairing, day close.
- `supabase/adminSync.test.ts`: the admin's local store syncing with the database (changes up, rows down, a refused change re-pulled).
- `supabase/seed.test.ts`: `seed.sql` still matches `kaunta-handoff/data/seed.json`. After changing the seed, run `npm run seed:sql`.
