# Kaunta on Supabase

The server for counter sync (build step 4) and the admin screens (build step 5). Phones never read or write tables
directly: row level security is on with no policies and table grants are
revoked. They call three functions with the project's publishable key:

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

Owners sign in with a username and password, managers with a username and a
4-digit PIN (`20261121000000_kaunta_accounts.sql`): accounts live on the server
(bcrypt, 5 wrong tries lock an account 15 minutes), and signing in
(`account_sign_in`) gives a session token. Everything else goes through one
function, `kaunta_admin(session, call, args)`, which runs the call as that
account's `people` row in the bar (role `owner` or `admin`). The calls
(`20261111000000_kaunta_admin.sql` and later):

| Function | What it does | Rules |
|---|---|---|
| `admin_pull(since)` | Everything changed since the cursor, for the admin's local store: last 35 business days of sales, approvals, shifts, deliveries, day closes, stock movements, and the audit log with each event's detail. | R-AUD-1 |
| `admin_push(events)` | Applies admin decisions and changes in order, idempotently by id: approvals (with a 2-minute undo), product and price changes, deliveries, shelf counts, kegs, unlock / PIN reset / add / archive people, revoke a phone, close the day. A change that can't apply (say another admin decided first) is answered `rejected` and changes nothing. | R-VOID-2…4, R-COMP-1, R-STOCK-2…4, R-KEG-1…3, R-PIN-1/2, R-DEV-2, R-DAY-3 |
| `admin_create_pairing_code(name)` | A 6-digit code for a new counter phone, recorded as made by that admin. | R-DEV-1 |
| `admin_bars`, `admin_me`, `admin_platform` | The bars they run (suspended bars left out); their account, how many bars they may own, bars suspended on them; their managers. | |
| `admin_create_bar(name)` | An owner starts another bar, within the number Kaunta allows (`bar_limit`). | |
| `admin_change_secret(current, next, counter_hash)` | Their own password or PIN. | |
| `admin_create_manager`, `admin_add_manager`, `admin_remove_manager` | An owner adds a manager to one or more of their own bars, adds an existing manager of theirs to another bar, or takes one off a bar. Audited in each bar. | |

Counter phones check owners' passwords and managers' PINs offline, so the app
sends a PBKDF2 hash (`counter_hash`, the format of `src/domain/pin.ts`) with
every new or changed password or PIN; it goes on the account's `people` row in
each bar. The server's own bcrypt hash is only used to sign in.

**Kaunta** (the super admin, `/super`) signs in with a password kept on the
server (`super_sign_in`, 5 wrong tries lock it 15 minutes, sessions last 12
hours) and calls `kaunta_super(session, call, args)`: `super_platform`,
`super_create_owner`, `super_add_manager`, `super_reset_secret`,
`super_set_bar_limit`, `super_set_bar_suspended`, `super_change_password`, and
any bar's calls (`admin_pull`, `admin_push`, `admin_set_bar_code`…) as the
person `kaunta`, so what Kaunta does is audited as Kaunta and the app leaves it
out of owners' and managers' logs. A suspended bar: its owner and managers get
`bar_suspended`, its phones get `{error: 'bar_suspended'}` from sync (and sign
everyone out until access is given back), and its code no longer joins phones.

People linked to Supabase Auth the old way (`people.auth_user_id`) can still
call the admin functions directly; the app no longer uses that.
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
2. Apply the migrations, in file-name order. With the CLI (recommended):

   ```sh
   npx supabase login
   npx supabase link --project-ref <your project ref>
   npx supabase db push
   ```

   Or in **SQL Editor**, run each file in `supabase/migrations/` in order (`20261110000000_kaunta_sync.sql` first, `20261121000000_kaunta_accounts.sql` last). They need the `pgcrypto` extension, which Supabase has; the last migration turns it on if it is off.
3. For the sample data (Baraka Pub, as in the designs), also run `supabase/seed.sql` (CLI: `psql "<connection string>" < supabase/seed.sql`). A real bar is created by Kaunta in step 5, so skip it for a real project.
4. Set Kaunta's password, once, in **SQL Editor** (8+ characters; run it again to change it if it is lost, which also signs Kaunta out everywhere):

   ```sql
   select public.set_super_password('a long password only Kaunta knows');
   ```

5. In **Project Settings → API Keys**, copy the project URL and the **Publishable key** (`sb_publishable_…`) into `.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`; the file is there with both empty). A project still on legacy keys can use its `anon` key as the publishable key. Never put the secret key or `service_role` key in the app. Restart `npm run dev`.
6. Open `/super`, sign in with Kaunta's password, and **Add an owner**: their name, username, the password Kaunta gives them, how many bars they may open, and their first bar (its code is made, or typed). Give the owner their username, password and the bar's code.
7. The owner signs in at **Owner or manager sign in** (`/admin`), adds their menu and staff, and adds managers under **Staff & devices → Managers**.
8. On each counter phone, **Open the counter** and type the bar's code (or a one-time 6-digit code from **Staff & devices → Add a counter phone**). Staff tap their name and type the PIN the owner or a manager set.

On the sample data: `seed.sql`'s people have no accounts. To sign in to Baraka Pub as its owner, create an owner in `/super` and put them in it in **SQL Editor**:

```sql
update public.people set account_id = (select id from public.accounts where username = 'njeri') where id = 'p_njeri';
update public.bar set owner_account_id = (select id from public.accounts where username = 'njeri') where id = 'bar_baraka';
```

(Their first bar from step 6 stays theirs too; Kaunta can suspend it.)

## Push notifications (OneSignal)

Web push for owners, managers and counter phones, sent by the database (`20261125000000_kaunta_notifications.sql`).

| Who | When |
|---|---|
| Owners and managers of the bar | A request waits for them (void, spilled or broken, on the house, expense, price to check, sold off the menu, removed phone); stock reaches its warning level; a counter shift starts or closes |
| The counter phone | An order is still unpaid after `bar.unpaid_alert_minutes` (5); an admin approves or rejects a request made on that phone |

Messages are in English and Kiswahili (OneSignal picks by the language set in the app).

**Keys you provide** (OneSignal dashboard → your app → Settings → Keys & IDs):

1. **App ID** (a UUID): into `.env.local` as `VITE_ONESIGNAL_APP_ID`, and into Supabase Vault (below). It is public.
2. **REST API Key**: into Supabase Vault only. It is secret: never in `.env.local` or the app.
3. Optional **Safari Web ID** (`web.onesignal.auto.…`, older Safari on Mac): `VITE_ONESIGNAL_SAFARI_WEB_ID`.

**Set up once:**

1. Create a OneSignal app, platform **Web**, "Typical site". Site URL: the address the app is served from (HTTPS; `http://localhost:5173` works for trying it out). Turn **off** OneSignal's own prompts and bell (Kaunta asks with its own button). Under advanced settings, the service worker is `push/onesignal/OneSignalSDKWorker.js` with scope `/push/onesignal/` (the app passes these itself; the file is in `public/`).
2. In Supabase **SQL Editor**:
   ```sql
   select vault.create_secret('<OneSignal App ID>', 'onesignal_app_id');
   select vault.create_secret('<OneSignal REST API Key>', 'onesignal_rest_api_key');
   ```
   To change one later: `select vault.update_secret((select id from vault.secrets where name = 'onesignal_rest_api_key'), '<new key>');`
3. Put the App ID in `.env.local` (`VITE_ONESIGNAL_APP_ID=…`) and restart `npm run dev` (or rebuild).
4. Check: `select public.kaunta_notifications_check();` should say `app_id_set`, `rest_api_key_set` and `timer_running` are all true. If `timer_running` is false, turn on **pg_net** and **pg_cron** under Database → Extensions, then run:
   ```sql
   select cron.schedule('kaunta-notifications', '15 seconds', 'select public.kaunta_notify_tick()');
   ```
5. In the app: owners and managers tap their avatar → **Turn on notifications**; on each counter phone, tap your name (top left on Sell) → **Turn on notifications**. iPhones need Kaunta added to the Home Screen first (iOS 16.4+).

**How it works:** triggers on `approvals`, `products`, `sizes` and `shifts` put each message in `public.notifications` (an outbox the app never reads). Every 15 seconds pg_cron runs `kaunta_notify_tick()`: it adds the unpaid-order reminders, then sends what is waiting to `https://api.onesignal.com/notifications` with pg_net, addressed by OneSignal external id: `account_<accounts.id>` for owners and managers, `device_<devices.id>` for counter phones (the app logs in to OneSignal with those). Until both keys are in Vault nothing is sent; messages older than 10 minutes are dropped, so adding the keys later does not send a backlog. See what went out with `select kind, status, contents->>'en', created_at, error from public.notifications order by id desc limit 20;` and OneSignal's answers in `net._http_response`.

Limits: one browser is one OneSignal user, so a browser used for both admin and a counter gets the notifications of whichever it signed in as last. Owners and managers need an account (made in `/super`); seed people without one get none.

## Many bars on one project

Every bar-scoped row has a `bar_id`. The functions that work inside a bar (`sync_push`, `sync_pull`, `admin_push`, `admin_pull`, `admin_create_pairing_code`) run as the role `kaunta_api`, and row level security shows that role only the rows of one bar. The bar is fixed at the start of each call from something the caller cannot forge:

- **A counter phone** belongs to the bar whose pairing code it used. Its device token decides the bar on every sync, so a phone only ever sees and writes its own bar.
- **An owner or admin** has one `people` row per bar, all linked to the same account (`people.account_id`). `admin_bars()` lists them; each admin call names a bar (`p_bar_id`) and is refused (`not_admin`) unless they are an owner or admin there.
- **An owner** starts another bar with `admin_create_bar(name)`: the bar with default settings, and them as its owner. It opens on first run (no products).

A counter phone joins a bar with the bar's code (`pair_with_bar_code`), or a one-time 6-digit code (`pair_device`). Wrong codes of either kind count toward one rate limit (20 in 10 minutes). Owners replace a leaked code with `admin_new_bar_code(bar)`; phones already joined keep working and can be revoked one by one.

Categories are shared by all bars. Order numbers, day closes and sign-ins are per bar. In the SQL editor (which is not subject to RLS), a new row gets the only bar automatically while there is one bar; with several bars, give `bar_id`.

The sample `seed.sql` is the counter's snapshot (five open orders at 22:20). The admin demo without a server runs on the whole sample night instead (`src/domain/sampleDay.ts`), so Today shows the design's totals there; on a server it shows whatever the counters have recorded.


## Tests

`npm test` runs the migrations in PGlite (real Postgres compiled to WebAssembly, no Docker, with pgcrypto), with Supabase's `anon`/`authenticated`/`service_role` roles created first:

- `supabase/sync.test.ts`: every function, each event type, each conflict rule, and that the anon role cannot read tables or make pairing codes.
- `supabase/phones.test.ts`: real phone stores (IndexedDB) syncing with the database, including two counters and an offline price change.
- `supabase/admin.test.ts`: who may call the admin functions, every admin event, undo, idempotency, a PIN reset reaching a counter, revoking, pairing, day close.
- `supabase/adminSync.test.ts`: the admin's local store syncing with the database (changes up, rows down, a refused change re-pulled).
- `supabase/firstRun.test.ts`: a project with the migrations only (no seed) has the categories and takes the first-run presets.
- `supabase/multiBar.test.ts`: an owner lists and starts bars; each bar sees only its rows; a change aimed at another bar's row is refused; an admin of one bar is not an admin of another; a phone paired by one bar syncs only that bar and numbers its own day.
- `supabase/accounts.test.ts`: Kaunta's password and lock; owners created with their first bar and a bar limit; sign-in, lockout and changing a password; owners adding and removing managers (and not taking another owner's); a suspended bar shutting out its owner, managers and phones but not Kaunta; Kaunta's changes audited as `kaunta`; the publishable key reaching only the entry points.
- `supabase/seed.test.ts`: `seed.sql` still matches `kaunta-handoff/data/seed.json`. After changing the seed, run `npm run seed:sql`.
