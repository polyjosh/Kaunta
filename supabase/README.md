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

Staff access (`20261118000000_kaunta_staff_access.sql`): owners and managers
set counter staff's 4-digit PINs with the admin event `pin_changed` (staff
can't: a counter's `pin_set` is refused). `people.pin_code` keeps the digits so
admins can look them up; `admin_pull` returns it, `sync_pull` never sends it to
counter phones (they get only the hash), and the event store and audit log keep
the change without the digits or hash. `person_suspended` / `person_reinstated`
take counter staff and servers off every counter and give access back; a phone
that has them logged in signs them out with its next pull, and what it had
queued is still accepted.

## Set up a project

1. Create a project at [supabase.com](https://supabase.com) (any region; `eu-central` or `af-south` are closest to Kenya).
2. In **SQL Editor**, run the migrations in order: `supabase/migrations/20261110000000_kaunta_sync.sql`, then `20261111000000_kaunta_admin.sql`, then `20261112000000_kaunta_categories.sql` (the five counter categories), then `20261116000000_kaunta_multi_bar.sql` (many bars on one project), then `20261117000000_kaunta_bar_codes.sql` (each bar's counter code).
3. For the sample data (Baraka Pub, as in the designs), also run `supabase/seed.sql`. For a real bar, create the first bar and its owner instead:

   ```sql
   insert into public.bar (id, name) values ('bar_kilimani', 'Kilimani Lounge');
   insert into public.people (id, bar_id, name, initial, colour, role, login)
   values ('p_owner', 'bar_kilimani', 'Amina', 'A', '#F2A0A0', 'owner', 'password');
   ```

   Further bars are started by that owner from the admin screens (the bar's name at the top → **Add a bar**).
4. In **Project Settings → API**, copy the Project URL and the `anon` `public` key into `.env.local` (start from `.env.example`). Never use the `service_role` key in the app.
5. Run `npm run dev`. The counter shows **Connect this phone**.
6. Every bar has a counter code (`select name, counter_code from public.bar;`; the sample bar's is `BRKAPUB2`). On the phone, tap **Open the counter** and type it (shown as `BRKA-PUB2`). Or, for tighter control, make a one-time pairing code in the SQL Editor (valid 10 minutes, works once):

   ```sql
   select create_pairing_code('Counter 1', 'd_counter1');  -- re-pair the sample "Counter 1"
   select create_pairing_code('Counter 3');                 -- or a brand-new device
   -- With more than one bar on the project, say which bar the phone is for:
   select create_pairing_code('Counter 1', null, null, 'bar_kilimani');
   ```

   Type the code on the phone. It pulls the menu, staff and open orders, then shows the staff list.

7. Give the owner an admin sign-in. In **Authentication → Users → Add user**, create a user with the owner's phone number (or email) and a password, and tick *Auto confirm*. Copy the user's id and link it:

   ```sql
   update public.people set auth_user_id = '<the user id>', phone = '+2547…' where id = 'p_njeri';
   ```

   Open `/admin` and sign in. From there, **Staff & devices → Make pairing code** replaces step 6, and other admins are linked the same way.

## Many bars on one project

Every bar-scoped row has a `bar_id`. The functions that work inside a bar (`sync_push`, `sync_pull`, `admin_push`, `admin_pull`, `admin_create_pairing_code`) run as the role `kaunta_api`, and row level security shows that role only the rows of one bar. The bar is fixed at the start of each call from something the caller cannot forge:

- **A counter phone** belongs to the bar whose pairing code it used. Its device token decides the bar on every sync, so a phone only ever sees and writes its own bar.
- **An owner or admin** has one `people` row per bar, all linked to the same sign-in. `admin_bars()` lists them; each admin call names a bar (`p_bar_id`) and is refused (`not_admin`) unless they are an owner or admin there.
- **An owner** starts another bar with `admin_create_bar(name)`: the bar with default settings, and them as its owner. It opens on first run (no products).

A counter phone joins a bar with the bar's code (`pair_with_bar_code`), or a one-time 6-digit code (`pair_device`). Wrong codes of either kind count toward one rate limit (20 in 10 minutes). Owners replace a leaked code with `admin_new_bar_code(bar)`; phones already joined keep working and can be revoked one by one.

Categories are shared by all bars. Order numbers, day closes and sign-ins are per bar. In the SQL editor (which is not subject to RLS), a new row gets the only bar automatically while there is one bar; with several bars, give `bar_id`.

The sample `seed.sql` is the counter's snapshot (five open orders at 22:20). The admin demo without a server runs on the whole sample night instead (`src/domain/sampleDay.ts`), so Today shows the design's totals there; on a server it shows whatever the counters have recorded.

With the CLI instead: `supabase link` then `supabase db push`, and `psql < supabase/seed.sql` for the sample data.

## Tests

`npm test` runs this migration in PGlite (real Postgres compiled to WebAssembly, no Docker), with Supabase's `anon`/`authenticated`/`service_role` roles created first:

- `supabase/sync.test.ts`: every function, each event type, each conflict rule, and that the anon role cannot read tables or make pairing codes.
- `supabase/phones.test.ts`: real phone stores (IndexedDB) syncing with the database, including two counters and an offline price change.
- `supabase/admin.test.ts`: who may call the admin functions, every admin event, undo, idempotency, a PIN reset reaching a counter, revoking, pairing, day close.
- `supabase/adminSync.test.ts`: the admin's local store syncing with the database (changes up, rows down, a refused change re-pulled).
- `supabase/firstRun.test.ts`: a project with the migrations only (no seed) has the categories and takes the first-run presets.
- `supabase/multiBar.test.ts`: an owner lists and starts bars; each bar sees only its rows; a change aimed at another bar's row is refused; an admin of one bar is not an admin of another; a phone paired by one bar syncs only that bar and numbers its own day.
- `supabase/seed.test.ts`: `seed.sql` still matches `kaunta-handoff/data/seed.json`. After changing the seed, run `npm run seed:sql`.
