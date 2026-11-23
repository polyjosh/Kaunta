# Kaunta: project status

Instructions, non-negotiables and the build order live in `kaunta-handoff/CLAUDE.md`; read it and `kaunta-handoff/docs/` first. This file records where the build stands.

Last updated: 2026-11-17 (everything on the server: accounts, Kaunta, limits, suspension, managers).

## Build order

| Step | Status | Where |
|---|---|---|
| 1. Tokens, theme, i18n, `formatKES`, StatusChip, SyncPill | ✅ Done | `src/lib`, `src/components`, `/dev/components` |
| 2. Data model, seed, local store, outbox | ✅ Done | `src/domain`, `src/data` |
| 3. Counter screens (login → sell → orders → payment → void → shift close → sync) | ✅ Done | `src/counter` |
| 4. Sync engine + Supabase server | ✅ Done | `src/sync`, `supabase/migrations/20261110000000_kaunta_sync.sql` |
| 5. Admin screens (Today → Approvals → Reconcile → Feed → Product → Stock → Kegs → Staff → Audit) | ✅ Done | `src/admin`, `supabase/migrations/20261111000000_kaunta_admin.sql` |
| 6. Empty and error states | ✅ Done | see below; `supabase/migrations/20261112000000_kaunta_categories.sql` |
| + Brand, landing page, many bars (asked for after step 6) | ✅ Done | see below; `supabase/migrations/20261116000000_kaunta_multi_bar.sql` |
| + Bar codes, demo that works end to end in one browser, installable app | ✅ Done | see below; `supabase/migrations/20261117000000_kaunta_bar_codes.sql` |
| + Super admin, owner accounts (username + PIN), owner-chosen bar codes | ✅ Demo and server | see below; `src/platform/`, `supabase/migrations/20261121000000_kaunta_accounts.sql` |
| + Staff access: PINs set and seen by owners/managers, suspend, owners and managers sell at the counter | ✅ Demo; server: PINs + suspend | see below; `supabase/migrations/20261118000000_kaunta_staff_access.sql` |
| + Adding stock: typed quantities, remove lines, packs per product, remove sizes, warning level per mode | ✅ | see below; `supabase/migrations/20261119000000_kaunta_stock_packs.sql` |
| + Owners add managers to their own bars | ✅ Demo and server | see below; `src/admin/ManagersCard.tsx` |
| + Stock per size (250 ml and 750 ml apart) | ✅ | see below; `supabase/migrations/20261120000000_kaunta_size_stock.sql` |
| + Kaunta: bar limits, suspend bars and staff, open a bar's admin, hidden from owners' logs | ✅ Demo and server | see below; `src/platform/` |
| + Everything on the live server (accounts, Kaunta, keys) | ✅ Migrations applied to the live project (2026-11-18, no seed) | see below; `supabase/README.md` → Set up a project |

### Step 6 detail (`docs/screens.md` → Empty and error states)

- ✅ No open orders: counter Open orders.
- ✅ Offline with queued orders: sync pill and the Sync screen.
- ✅ Sync failure needing admin review: counter pill and needs-review card, and an item in admin Approvals.
- ✅ Search with no results: Sell.
- ✅ PIN locked: Login.
- ✅ Shift close blocked: Shift close.
- ✅ First run, no products: admin Today and Products show `FirstRun` (`src/admin/FirstRun.tsx`) with 12 preset chips, all ticked. "Add N products" saves each ticked preset as a `product_saved` admin event (audited, synced) in one local transaction; "Start from blank" opens the product editor. Presets (`src/domain/presets.ts`) are the seed's products with their sizes and placeholder prices, shelf at 0 (food and keg not tracked), seed ids so two admins adding them at once make one product each.
- Categories: a fresh server had none (only `seed.sql` inserted them), so a real bar could not add products. The categories migration inserts the five; `seed.sql` now upserts them.

## Brand, landing page, many bars

- **Logo** (`kaunta-handoff/design/logo`): favicon, PWA icons (192/512 and maskable), apple-touch icon and Open Graph image in `public/` and `public/brand/`; the old tally icons are gone. `Logo` (`src/components/Icon.tsx`) is the K-ruler mark drawn inline in the logo's own scheme colours (`--k-logo-ink`, `--k-logo-ember`: dark scheme on Night, light on Day). `Lockup` shows the outlined wordmark files: stacked-dark on the landing page, horizontal on admin sign-in and the bar picker. The counter keeps the mark in its top bar, where the stacked lockup would push the staff grid down.
- **Landing** (`/`, `src/routes/Landing.tsx`): stacked lockup with the tagline, the product promise, "Open the counter" and "Owner or manager sign in", language switch, and a line saying Kaunta never takes payments. Installed counter phones skip it: the manifest's `start_url` is still `/counter/login`.
- **How people reach the right bar**: a counter phone is bound to one bar by its pairing code, so it always opens straight to that bar's staff list. Owners and admins sign in, and the server lists their bars (`admin_bars`). With one bar it opens directly; with several it asks once ("Which bar?") and remembers the choice on that browser. The bar's name in the admin header switches bars, and owners can **Add a bar** there.
- **Server**: see `supabase/README.md` → Many bars on one project. Every bar-scoped table has `bar_id`; RLS for the `kaunta_api` role keeps each call inside one bar.
- **Admin client**: one local store per bar (`kaunta-admin-<bar id>`), all deleted on sign-out; the bar list is cached so admin still opens offline (`src/admin/bars.ts`). `AdminServer.forBar(id)` gives that bar's pull, push and pairing.
- **Demo**: the owner runs Baraka Pub (the sample night) and Baraka Lounge (not started: first run), and can start more; each has its own store.
- First-run preset ids are now `<bar id>:<seed id>` (product ids are global, so two bars can't both have `tusker`).

## Bar codes, the browser-only demo, installing

- **Bar code** (`src/domain/barCode.ts`): every bar gets a permanent counter code when it is created (8 characters, shown XXXX-XXXX, no 0/O/1/I/L). "Open the counter" on a device that has not joined a bar asks for it once (`src/counter/BarCodeScreen.tsx`); then staff tap their name and enter their PIN as before. A new person gets a one-time code from admin and chooses their PIN at the counter (R-PIN-2, unchanged). The sample bar's code is `BRKA-PUB2`, the demo's second bar `BRKA-4NGE`.
- **Admin**: `BarCodeCard` shows the code on Staff & devices, and on Today while a new bar has no products. Copy button; owners can make a new code (old one stops working for new phones; phones already in stay in).
- **Server**: `bar.counter_code`; `pair_with_bar_code(code)` makes the phone a device of that bar (same rate limit as pairing codes); `admin_new_bar_code(bar)` for owners; `admin_create_bar` returns the code. The counter's transport sends 6 digits to `pair_device`, anything else to `pair_with_bar_code`, so admin pairing codes still work.
- **Demo (no `.env.local`), all in browser storage**: bars are in `localStorage` (`kaunta.demoBars`, with codes); the counter remembers its bar (`kaunta.counterBar`, "Use this phone for another bar" on the login screen). A bar the owner adds has one IndexedDB store (`kaunta-bar-<id>`) shared by admin and the counter, and `src/data/demoServer.ts` stands in for the server: it marks the counter's queued changes sent and writes the audit rows, so sales show in admin's Today, Sales and Audit log at once. The sample bar keeps its two fixed-time stores (counter 22:20, admin 02:14), so counter sales there do not reach its admin.
- **Install (PWA)**: manifest `start_url` is `/`; the installed app goes on to the way the device used last (`kaunta.lastWay`), so a counter phone opens on its counter. Shortcuts for Counter and Admin. The landing page shows "Install Kaunta" when Chrome/Edge/Android offer it (`src/lib/install.ts`) and the Share → Add to Home Screen hint on iPhone. `npm run app` builds and serves the installable version on port 4173 (also on the local network). Installing needs HTTPS except on `localhost`, so a phone needs the app deployed (or a tunnel).
- Checked: Chrome reports no installability errors other than Playwright's incognito; the app starts offline from the service worker.

## Super admin, accounts, chosen bar codes (demo; browser storage)

- **Platform directory** (`src/platform/platform.ts`, `localStorage` key `kaunta.platform`): the super admin's password, owner and manager accounts, every bar with its code, and who runs which bar. Each bar's data stays in its IndexedDB store.
- **Super admin** at `/super` (`src/platform/SuperApp.tsx`, link at the foot of the landing page): password preset to `Kaunta@2026` until changed in Settings. **All bars** (today's served / collected / at risk per bar and in total, code, owner, products, staff, open orders), **bar detail** (today, code with change, who runs it + add a manager, counter staff, phones, menu, latest activity in the audit log's words), **Owners & managers** (bars, PIN state, set a new PIN which also unlocks), **Add an owner** (name, username, PIN Kaunta sets, first bar's name, bar code made or typed with a live uniqueness check), **Settings** (change password).
- **Owner or manager sign in** (`src/admin/OwnerSignIn.tsx`): username + 6-digit PIN, then only that person's bars. Five wrong PINs lock the account 15 minutes. Owners can start more bars; managers can't. **Your account** (`/admin/account`) changes the PIN; a banner suggests it while Kaunta's PIN is in force. Demo accounts: `njeri` / `246810` (owner of Baraka Pub and Baraka Lounge), `chebet` / `135790` (manager of Baraka Pub).
- **Bar codes chosen by owners** (`BarCodeCard`, `checkCode`): 6–12 letters or digits with at least one letter (so never a 6-digit pairing code's shape); unique across all bars, comparing look-alikes as one (O = 0, I = L = 1). "Make one for me" still makes a random one. The counter accepts any length 6–12. Server: `admin_set_bar_code(bar, code)` and a unique index on the canonical code (in `20261117000000_kaunta_bar_codes.sql`).
- Tests: `src/platform/platform.test.ts` (rules), `src/platform/super.test.tsx` (screens), `e2e/fullLoop.spec.ts` (super admin creates owner + bar → owner signs in → menu, staff → counter code → PIN → sale → admin and platform see it).

## Staff access (asked for after the super admin)

- **Counter PINs are set, never chosen** (`StaffScreen`, admin event `pin_changed`): 4 digits, typed or "Make one", when a counter person is added and with **Change PIN** later. Owners and managers see them (**Show**); Kaunta can too, and change them, on the bar's page at `/super`. Staff can't change their own: the counter's one-time-code flow is gone, someone without a PIN is told to ask the owner or a manager, and the server refuses a counter's `pin_set`. Every change is in the audit log ("PIN changed · name"), without the digits or hash. `Person.pin_code` holds the digits in admin stores; a server never sends it to phones.
- **Suspend instead of archive** (`person_suspended` / `person_reinstated`): counter staff and servers only (owners and managers are accounts). They leave the counter's list and the server picker; anyone suspended while logged in is signed out at once (`Session.tsx`), after what was in their Sell tray is saved as an open order (pay later); the login screen says why. A **Suspended** card on Staff & devices has **Give access back**. History stays.
- **Owners and managers sell at the counter**: they are on the counter's list (after staff, marked Owner / Manager). Owners type their password, managers their 4-digit PIN; both are checked on the phone (the account's hash is on their `people` row, `ensureMemberPeople`). Signed in to admin on this browser? **Sell at the counter** in the account menu goes straight in (`?from=admin`, `src/lib/adminHere.ts`), and so does tapping their own name. At the counter, **Open admin** in their menu opens admin on that bar without signing in (demo).
- **Accounts changed with it**: owners sign in with username + **password** (8+ characters), managers with username + **4-digit PIN**. Demo: `njeri` / `Baraka@2026`, `chebet` / `4826`. Older demo data is migrated (owners' old 6-digit PIN works as their password until changed; managers who chose 6 digits need Kaunta to set a 4-digit PIN). Sample counter staff all have demo PINs now: Wanjiku 2580, Otieno 1470, Akinyi 3691, Kiprop 8024, Mwangi 5813.
- The sample bar still has two stores (counter 22:20, admin 02:14): a PIN change or suspension there shows in admin only. Try the live sign-out with a bar created at `/super` (the e2e test does: two tabs, suspend in one, the counter in the other signs out).
- Tests: `src/counter/access.test.tsx`, Staff & devices in `src/admin/admin.test.tsx`, `supabase/admin.test.ts` (PINs, suspension, refused `pin_set`), `e2e/fullLoop.spec.ts`.

## Adding stock (asked for after staff access)

- **Add stock** (`StockScreen`): the number of crates, packs or single bottles can be typed; − and + stay. Each line has **Remove** until **Add to stock**.
- **Packs** (`Product.packs`, `products.packs`): what a product is delivered in ("Crate of 25", "Box of 12"; for spirits, boxes of one bottle size). Edited on the product under **Delivered in** (add, rename, change the count, remove), or added from the delivery screen with "+ Another pack size…", which saves it on the product (audited `product_saved`). Not set = the old crates of 24 and 25 (count) or none (ml). A single bottle, and one bottle of each size for spirits, is always offered.
- **Sizes can be removed** on the product: a new one goes at once; a saved one is removed on save (`sizes.archived_at`, sale switched off for good, Undo before saving). The row stays because orders and voids refer to it.
- **Warning level** follows the counting method chosen, before saving: Count → "Warn when the shelf count is at or below … bottles" (the counter's "N left" and Products' Low); Millilitres → in ml (Products' Low only; `isBelowAlert`). Each mode keeps its own value while switching. New products can set it before the first save.
- Tests: `src/admin/stock.test.tsx`, `supabase/admin.test.ts` (packs, removed size stays off).

## Owners add managers (asked for after adding stock)

- **Staff & devices → Managers** (`ManagersCard`), shown only to the owner of the open bar. Lists the bar's managers (with the owner's other bars they also run) and **+ Add a manager**:
  - **A new manager**: name, username, 4-digit PIN (typed or "Make one"), and which of the owner's bars they run (ticked: this one). The username and PIN are shown once to pass on.
  - **One of your managers**: anyone who already manages another of this owner's bars, added to this one. Only offered when there is someone to add.
  - **Remove** (with a confirm): off this bar only; the account and its other bars stay.
- Rules (`src/platform/platform.ts`: `createManager`, `addManagerToBar`, `removeManagerFromBar`, `managersOf`, `managedBars`): only into bars the owner owns; only managers of the owner's own bars can be added to another of them (an owner can't take another owner's manager by username); managers can't add managers.
- Each change is an audited admin event by the owner in that bar's store (`person_saved` "Added X · Admin", `person_archived` on removal; `managerAdded` / `managerRemoved` in `bars.ts`), so the manager opens the bar in admin and is on its counter's list with their PIN; removed, they are off both.
- Server: none yet (accounts are demo-only, see Not yet done). The super admin's **Add a manager** on bar detail still works.
- Tests: `src/platform/platform.test.ts` (rules), `src/admin/managers.test.tsx` (screen).

## Stock per size (asked for after owners add managers)

- **Product → How stock is counted → Keep each size's stock apart** (`Product.per_size`). Each size then has its own stock (`ProductSize.stock_qty`, in bottles for counted things and ml for spirits) and warning level (`low_stock_at`, typed in bottles). A size can be **poured from** another (`stock_from`: the tot from the 750 ml bottle; set by default when switched on for spirits). The product's `stock_qty` stays the sum, so totals elsewhere hold.
- Switching on puts all current stock on the largest size until each size is counted (the editor says so); switching off adds the sizes together. `rebalancePools` (`src/domain/stock.ts`) and the server's `apply_admin_event` do the same.
- **Sales, voids, comps, write-offs** move the stock of the size sold (or the one it is poured from): `shiftStock` (`src/data/pools.ts`), server `adjust_stock(…, p_size)` / `move_stock`. Movements and delivery lines carry `size_id`.
- **Add stock** offers each size and its packs ("250ml bottle", "Box of 12 (12 × 750ml)", "Crate of 24 (500ml)") and shows that size's "Now X → Y". **In stock, by size** on the product counts each size (spirits: full bottles + ml in an open one) and sets its warning.
- **Reflected**: Products shows each size's stock and Low per size; Today flags the size below zero ("Smirnoff Vodka 250ml is at −250 ml"); the counter's "N left" is per size (tile and size picker).
- **The stock figure is edited on the product** ("In stock now", or "<size> in stock now" per size), in the unit of the counting method selected: bottles for Count, ml for Millilitres. Changing the method converts the figure as a suggestion (at the largest bottle size, else 750 ml) and says so; the old number is never shown with the new unit. Saved as `shelf_counted` events (before → after in the audit log), with or without other product changes. This replaced the separate "Count shelf" step.
- Tests: `src/admin/sizeStock.test.tsx`, `supabase/admin.test.ts`.

## Kaunta (super admin) controls (asked for after stock per size)

- **Bars an owner may open** (`Account.max_bars`; null = no limit): set when creating an owner ("Bars they can open", default 1) and changed on **Owners & managers** ("2 of 3", Change, No limit). `createBar` refuses past it (`'limit'`); the owner's bar switcher then says to ask Kaunta instead of offering Add a bar. Lowering it below what they own keeps their bars. Demo: Njeri may own 3.
- **Suspend a bar** (`PlatformBar.suspended_at`; bar page → Access → Suspend bar, with a confirm; Give access back): `barsFor` leaves it out, so its owner and managers can't open it (a manager with no other bar sees "Your bar is suspended"); its counters show "This bar is suspended" instead of the staff list, so whoever was signed in is out. Records stay. **Bars** shows a Suspended chip.
- **Suspend counter staff** from the bar page (Suspend / Give access back next to each person's PIN): the same `person_suspended` / `person_reinstated` events an owner records, as Kaunta.
- **Open this bar's admin** (bar page): `/admin` opens that bar with every owner tab, as Kaunta (`superViewBar`, only while signed in to /super; works on a suspended bar too). A banner says so; **Back to Kaunta** returns to the bar page. Kaunta is not a person of the bar (`KAUNTA_PERSON`): not on its staff list or counter, no Sell at the counter.
- **Kaunta's actions are left out of what owners and managers see** (`visibleTo` in `AdminSession.tsx`): Audit log, Sales feed, Staff & devices and the product's "last changed". Kaunta's view and /super's activity list show them. The changes themselves (a PIN, a suspension, a price) still apply.
- Fixed on the way: the Audit log's **All days** showed today only; the sample bar's seed failed if an owner's or manager's row was written first (now `bulkPut`).
- Server: none of this yet (accounts and the platform are demo-only; see Not yet done).
- Tests: `src/platform/platform.test.ts`, `src/platform/kaunta.test.tsx`.

## On the live server (asked for after the Kaunta controls)

- **Keys**: `.env.local` (git-ignored) has `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, both empty, so the app stays the browser demo until they are filled (`.env.example` explains them). The app sends only the publishable key, in the `apikey` header (`restHeaders`, `src/sync/config.ts`); a legacy `anon` key works too (`VITE_SUPABASE_ANON_KEY` fallback). No secret or `service_role` key anywhere in the app.
- **Migration** `20261121000000_kaunta_accounts.sql`: `accounts` (bcrypt via pgcrypto, lockout, `max_bars`), `account_sessions`, `platform_settings` (Kaunta's password, set once with `set_super_password` in the SQL editor), `super_sessions`; `people.account_id`; `bar.owner_account_id/created_by/created_at/suspended_at`. Entry points for the publishable key: `account_sign_in`, `kaunta_admin(session, call, args)`, `super_sign_in`, `kaunta_super(session, call, args)`, plus pairing and sync (which refuse a suspended bar). `current_admin` now also knows accounts and Kaunta (the person `kaunta`). All other functions are revoked from `anon`/`authenticated` again (functions made after the last revoke had kept PUBLIC execute).
- **App**: admin signs in with username + password/PIN on the server too (`AdminServer`, sessions; Supabase Auth sign-in removed, `AdminSignIn.tsx` deleted). `src/platform/actions.ts` does every platform change in the demo or on the server; with a server the screens' platform is the server's (`setLivePlatform`), never browser storage. `/super` signs in on the server and reads each bar by pulling it as Kaunta (`kaunta-super-<bar>` stores, `setSnapshotSource`). Kaunta's "Open this bar's admin" on the server: `KauntaLiveBar`. A suspended bar's counter shows the suspended screen (`stopped: 'suspended'`) and recovers by itself when access is given back.
- Passwords and PINs: the server keeps bcrypt for sign-in; the app sends the PBKDF2 hash counters check offline (`counter_hash`) with every new or changed one.
- `supabase/config.toml` (minimal) for `npx supabase link` / `db push`.
- Tests: `supabase/accounts.test.ts` (functions), `supabase/liveClient.test.ts` (the app's own client against the migrations through a REST-to-SQL fetch, as `anon`), `src/admin/live.test.tsx`.
- Not done: never run against a real Supabase project; the super admin pulls each bar in full to show its figures (fine for a handful of bars, slow for hundreds); seed.sql's sample people have no accounts (README shows how to attach one).

## Shift float and expenses; save by Add stock (asked for after the live server)

- **Float** (`StartShift` in `src/counter/LoginScreen.tsx`): after the PIN, someone with no open shift on this phone types the cash in the drawer (keypad; "Start shift with no float" for 0). `startShift(db, ctx, floatKes)`; an open shift carries on with its own float. Travels in `shift_opened` as before.
- **Expenses** (`/counter/shift/expenses`, `ExpensesScreen`; in the account menu and as "Add" on Close shift): what for, amount, and **Cash drawer** or **M-Pesa till** (`ShiftExpense.paid_from`, missing = cash for older data). Events `shift_expense_added` / `shift_expense_removed` (the whole expense, for the audit log). Cash ones come off the cash expected (`expensesTotal`); till ones (`tillExpensesTotal`) come off what the M-Pesa till statement should show: Reconcile says "− KES X paid out from the till · expect Y" and `mpesaVariance(recorded, till, tillPaidOut)`. Close shift's row now reads "− Expenses from the drawer".
- Server: `20261123000000_kaunta_shift_expenses.sql` (`apply_event` handles both events: shift on this device, open, whole KES > 0, cash/mpesa, added once). Pushed to the live project 2026-11-19.
- **Products**: the Save button next to Add stock (`StockActions`) now saves any change to the product ("Save product"; "Save stock" when only stock changed), with the error shown there too.
- Decision (confirmed with the product owner): "till" for expenses means the M-Pesa till, not the drawer.
- Tests: `src/counter/expenses.test.tsx`, `supabase/sync.test.ts` (expenses), Reconcile in `src/admin/admin.test.tsx`, `src/admin/sizeStock.test.tsx` (Save product), `e2e/fullLoop.spec.ts` (float).

## Approvals from the counter, 2-minute self-void (asked for after shift expenses)

- **Expenses need approval**: `addExpense` also records an `expense` approval (target `shift_id` + `expense_id`, `reason_code` = cash/mpesa, `detail.label`). It counts while waiting and once approved; rejected, it stops counting (`rejectedExpenses`, passed to `expensesTotal` / `tillExpensesTotal` / `expectedCash`, used by Close shift, Expenses and Reconcile). Removing it is allowed only while it waits (approval → `cancelled`). Admin card: "Expense" in Approvals.
- **Rejections at the counter** (`DecisionNotices` on Sell): the person who asked sees their rejected void, breakage or expense until they tap OK (seen ids in `localStorage` `kaunta.seenDecisions`). Expenses show Waiting / Approved / Rejected.
- **Paying takes back a void request**: paying the whole amount of an order with waiting void/write-off requests records `void_request_cancelled` first (lines back to active, approval `cancelled`, off the admin list), then the payment. The payment sheet warns before confirming. A part payment leaves the request. On the server, a request already decided is kept and the event goes to review (`void_already_decided`).
- **Self-void window 2 minutes** (seed, new bars, and live bars that had 5). A paid order still goes to an admin (money would go back; confirmed with the product owner), and the void screen now says so ("Already paid: an admin decides") instead of offering "Void item".
- **Close shift went blank sometimes** (not reproduced on the demo): any error on a counter screen now shows `ScreenErrorBoundary` (message + Back to selling) instead of a blank page; login waits for the phone's own record before starting a shift (a shift with no device would never be found at close); Close shift with no open shift says so and offers Switch user.
- `ApprovalStatus` gained `cancelled` (a trigger keeps it final on the server); `ApprovalKind` gained `expense`.
- Server: `20261124000000_kaunta_counter_approvals.sql`. Tests: `src/counter/approvals.test.tsx`, `supabase/counterApprovals.test.ts`, `src/components/ErrorBoundary.test.tsx`, Approvals in `src/admin/admin.test.tsx`.

## Push notifications, OneSignal (asked for after counter approvals)

- **Server** (`20261125000000_kaunta_notifications.sql`): triggers on approvals (waiting → owners/managers; decided → the phone that asked), products/sizes (stock crossing its warning level), shifts (opened, closed) queue rows in `public.notifications` (outbox, RLS on, no grants). pg_cron runs `kaunta_notify_tick()` every 15 s: unpaid-order reminders (`bar.unpaid_alert_minutes`, default 5, one per order, to `device_<id>`), then `send_notifications()` posts to OneSignal with pg_net, key from Vault (`onesignal_app_id`, `onesignal_rest_api_key`). No keys: nothing sent; > 10 min old: expired. `kaunta_notifications_check()` for the SQL editor. The cron/pg_net block is skipped where the extensions are missing (PGlite).
- **App** (`src/lib/push.ts`): OneSignal web SDK v16 loaded only with `VITE_ONESIGNAL_APP_ID` and a server; its service worker in its own scope (`public/push/onesignal/`, kept out of the app's precache). Counter phones log in as `device_<device id>` (`CounterPush` in App), owners/managers as `account_<account id>` (AdminLive; logout on sign-out). **Turn on notifications** in the counter's name menu and the admin avatar menu (`PushButton`).
- **Fixed 2026-11-23: screens failed once push was live** ("Class constructor t cannot be invoked without 'new'" after the PIN; also the blank owner/manager page on mobile). OneSignal v16 hands the app its SDK as a class; `usePush` stored it with `setSdk(s)`, and React calls a function given to setState as an updater. Now `setSdk(() => s)`. Test with a class-shaped SDK in `src/lib/push.test.tsx` (the plain-object stand-in had hidden it).
- **Asked after signing in** (`PushPrompt`, `src/components/PushPrompt.tsx`): on Sell after the PIN, and in admin after sign-in (not for Kaunta viewing a bar), a browser that has not allowed notifications gets a dialog: **Turn on** (the browser's own question; browsers only ask after a tap) or **Not now** (hidden until the next sign-in: `sessionStorage` `kaunta.pushPrompt`, cleared by `resetPushPrompt()` at counter login and admin sign-in). Blocked: how to allow them in the browser's site settings. iPhone outside the Home Screen app: add it there first. Nothing while push is not set up (no App ID, or the demo) or already on. Tests in `src/lib/push.test.tsx`.
- **Keys the owner provides** (checked against OneSignal's docs 2026-11-23): the **App ID** (Vercel `VITE_ONESIGNAL_APP_ID` + Vault `onesignal_app_id`) and an **App API key** (Settings → Keys & IDs → Add Key; starts `os_v2_app_`, shown once; Vault `onesignal_app_api_key` only, the old name `onesignal_rest_api_key` still read: `20261128000000_kaunta_onesignal_app_api_key.sql`). `VITE_ONESIGNAL_SAFARI_WEB_ID` removed (legacy Safari only). OneSignal app set up as Web → **Custom Code**. No Safari key needed (macOS 13+/iOS 16.4+ use standard web push). The server already uses the current API (`api.onesignal.com/notifications`, `Authorization: Key …`, `include_aliases.external_id`, Web SDK v16). Steps: `supabase/README.md` → Push notifications.
- Not yet: keys not set; never sent through real OneSignal (sending tested with stand-in `net`/`vault` in `supabase/notifications.test.ts`).
- Tests: `supabase/notifications.test.ts`, `src/lib/push.test.tsx`.

## Other days on Today and Reconcile; Kaunta resets a bar (asked for after the rename)

- **Calendar** (`src/admin/DayPicker.tsx`): a calendar button opens the browser's date picker, from 35 days back (`DAYS_KEPT`, what `admin_pull` keeps on the device) to today. Today takes `/admin?day=YYYY-MM-DD` ("Sales · Mon 9 Nov", "Did I lose money on …?", Back to today; a day that is today or later is today); Reconcile goes to `/admin/reconcile/<day>`.
- **Reset a bar** (`/super` → bar page → Start this bar again; typing the bar's name confirms): server `super_reset_bar` (`20261126000000_kaunta_bar_reset.sql`, through `kaunta_super`) deletes every record of the bar (orders, lines, payments, stock movements, approvals, shifts, events, audit log, deliveries, day closes, kegs, products, sizes, price history, devices, pairing codes, notifications) and every person but the owner; managers' accounts that run no other bar and own none are deleted. The bar, code, settings, owner and owner's account stay; one `bar_reset` audit row by Kaunta. The audit log's append-only trigger lets deletes through only while `kaunta.reset_bar` is set (inside the reset). `bar.reset_at` makes `applyAdminPull` drop a browser's copy and pull from the start; counter phones lose their device and ask for the bar code. Demo: `resetBarMembers` + the bar's store deleted (the sample bar comes back as the sample night).
- Tests: `supabase/barReset.test.ts`, `src/platform/reset.test.tsx`, calendar tests in `src/admin/admin.test.tsx`.

## Sales this shift at the counter; two fixes (2026-11-23)

- **Sales this shift** (`/counter/shift/sales`, `ShiftSalesScreen`; in the counter's name menu): every order this person served, recorded or took over in their open shift on this phone, newest first, with filters **All / Pending / Paid / Cancelled**. Cancelled = voided, or with a void asked for or done on part of it; each such card says where it stands: "Void waiting for approval", "Void approved by X", "Void rejected by X · still sold", or "Voided at the counter · no approval needed" (inside the self-void window). A card opens the order; its back button returns to the list. Rules in `src/domain/shiftSales.ts` (tests next to it).
- **Admin account menu on phones**: when the header wrapped, the avatar moved to the left and the menu (anchored to its right) ran off the screen. `.a-header-tools` now stays on the right; the menu scrolls if the screen is short.
- **"← Kaunta Book" on the sign-in cards** (owner/manager and /super) goes to `/?home`; the landing page does not send the installed app back to its last way when `?home` is there (that redirect is why the link seemed dead). The lockup on the owner sign-in card links home too.

## Sync fix, error screens, small changes (2026-11-23, after push notifications)

- **Paid on one counter, still pending on another (fixed)**: `sync_pull` sent orders, lines and payments only while open or from today/yesterday (approvals: waiting or 2 days; shifts: open or opened in 2 days). An older order paid elsewhere matched neither once paid, so other phones kept it pending (seen live: 20 Nov orders paid on Counter 3 on 23 Nov, pending on Counter 2). `20261129000000_kaunta_pull_any_day.sql`: the window now applies only to a phone's first pull; after that every row changed since the cursor comes down. The migration also touches `updated_at` on rows changed in the last 14 days (no status column written, so no notification triggers) so phones that had skipped them take them once. Tests: `supabase/pullAnyDay.test.ts` (fails without the migration).
- **Phones pull every 20 s** (was 60 s) and at once when the app comes back to the front (`visibilitychange` in `src/sync/engine.ts`).
- **Admin and /super have the error screen** the counter has (`ScreenErrorBoundary` around both routes in `App.tsx`; "Back to Today" / "Back to all bars", and Reload): a failing screen shows its error message instead of a blank page. Reported: "the owner/manager page blanks out on mobile"; not reproduced (demo, live sign-in page on Pixel 7 / iPhone 13 sizes all fine, no console errors). The message on the error screen says what fails.
- **"Sales this shift" is now "Sales History"** (title and name menu; Kiswahili "Historia ya mauzo").
- **Receipt paper control removed** from the counter's name menu (receipts use 80 mm; `paperWidth()` still reads `kaunta.paperWidth` if set).
- **No address on printed receipts**: `@page { margin: 0 }` is also in `receipt.css` (not only in the size set before printing), so browsers print no header/footer (title, URL, page numbers). If a print dialog still adds them, turn off "Headers and footers" in its settings.

## Sales this shift: another day (2026-11-23, after receipts)

- A calendar button on **Sales this shift** opens the phone's date picker. Picking a day shows **My sales** for that business day (`?day=YYYY-MM-DD`, kept when coming back from an order): this person's orders that day from any phone, handed-over orders going with the handover (`daySales` in `src/domain/shiftSales.ts`). Same All / Pending / Paid / Cancelled filters. **Back to this shift** returns. With no open shift, the screen shows today's sales instead of a dead end.
- Days offered: from the oldest day this phone holds to today. Phones never prune, but a phone only downloads the last 2 business days when it is paired (`sync_pull`'s `from_day`), so days before its pairing show only what it recorded itself. No server change.
- **Expenses on the same screen**: under the sales total, "N expenses · KES X" (rejected ones not counted, as at shift close), and an **Expenses · N** tab after Cancelled listing each one (what for, Cash drawer / M-Pesa till, time, Waiting / Approved / Rejected) with **Add or remove expenses** (the Expenses screen) in shift view. Shift view: this shift's expenses; day view: those of this person's shifts that started that business day, on any phone this one knows (phones get other phones' shifts for 2 days).
- Tests: `src/counter/shiftSales.test.tsx`, `daySales` in `src/domain/shiftSales.test.ts`.

## Receipts (2026-11-23, after the counter changes)

- **A receipt for every sale**: after **Record (pay later)** and **Record & paid** (`printAfterSale` in `SellScreen`), and **Print receipt** on any order (open, paid or voided) to print it again. Uses the phone's own print dialog (`window.print`), so it prints to whatever the phone can print to: a receipt printer through its Android print service, a Wi-Fi printer, or PDF. No printer drivers or Bluetooth code in the app.
- **What it shows** (`loadReceipt`, `src/data/receipt.ts`; works offline): bar name, order number and table, nickname, date and time (Nairobi), **Served by** (the server on the sale), Recorded by + phone, each item (size, qty × price, line total; "void asked" on lines waiting for a decision), total, each payment (Cash / M-Pesa with last 4), then To pay / Balance to pay / Paid in full / Voided, "Printed …" and Kaunta Book.
- **Layout** (`src/counter/Receipt.tsx`, `receipt.css`): drawn outside the app and shown only while printing (`body.k-printing`), black on white, monospace.
- **The page fits the receipt, like a supermarket till roll** (`fitPageToReceipt` / `receiptPageCss` in `Receipt.tsx`): just before printing, the receipt is laid out off screen at the roll's width and measured, and the page is set to `@page { size: <roll>mm <receipt length + 4 mm>mm; margin: 0 }` (at least 30 mm). A short receipt is a short page, a long one is one long page (never split); a roll printer feeds to the last line and stops (and cuts). Checked in Chrome: 1 item → 80 × 80 mm, 18 items → 80 × 246 mm, each one page. The print service should be set to the roll (or "custom/continuous" size), not A4.
- Paper: 80 mm (printable 72 mm). The per-phone 80/58 mm choice was removed from the name menu on 2026-11-23; `kaunta.paperWidth` = 58 still works if set.
- **Name menu → "Receipt after each sale: On/Off"**, per phone (`localStorage` `kaunta.printReceipts`, on unless turned off), for phones with no printer. Print receipt on an order works either way.
- The order number printed straight after a sale is the phone's; when two phones record offline at once the server can renumber one (R-DAY-2), so a receipt may show a number that later changes.
- Tests: `src/counter/receipt.test.tsx`. jsdom has no printing: `src/test/setup.ts` stubs `window.print`.

## Counter changes: nicknames, handover to a person, shift block (2026-11-23)

- **Hidden for now**: "Split bill" on an order and "Move to a new order" on a line (`SHOW_SPLIT_BILL` / `SHOW_MOVE` in `OrderDetailScreen.tsx`; the code and its tests stay, skipped). The Cash + M-Pesa split in the payment sheet is unchanged.
- **Nickname on open orders** (`Order.note`, ≤ 60 characters): **Add a nickname** / **Change nickname** on an open order (empty removes it); shown on the order, on Open orders and on Sales this shift. Event `order_noted` (`noteOrder` in `src/data/commands.ts`); audit "Nickname on #047 Table 4: “…”".
- **All** tab first on Sell, selected by default: every product on sale, grouped in tab order.
- **Hand over to a person**: Close shift → Hand over → pick who (everyone who signs in at the counter but you). `order_handed_over` now carries `to`; the order is theirs at once (`handed_over_to`): on their Open orders "Mine" and Sales this shift, blocking their shift close (from any phone), and credited to them in admin's per-server sales (`byServer`). Audit: "Order #047 handed over to Kiprop". Without `to` (older phones) it still waits for the next login on that phone.
- **No new shift while your last one has unpaid orders** (confirmed: the person's own shift only; two people can still share a phone). At login, with no open shift on this phone, `unsettledShiftsOf` looks for their open shifts on other phones with orders that would block its close; if any, "Your last shift is still open" (phone, since when, unpaid orders and amount) and no float/shift. A shift already open on this phone carries on as before.
- **Lockout kept**: removing it was asked for and then undone the same day; 5 wrong PINs or passwords still lock for 15 minutes (counter, owners and managers, Kaunta).
- Server: `20261127000000_kaunta_counter_handover_notes.sql` (`orders.note`, `apply_event` with `order_noted` and `order_handed_over`+`to`). **Not yet pushed to the live project.**
- Tests: `supabase/handoverNotes.test.ts`, `src/data/handover.test.ts`, nickname in `src/counter/orders.test.tsx`, All / shift alert in `src/counter/counter.test.tsx`, hand over in `src/counter/screens.test.tsx`.

## Renamed Kaunta Book (2026-11-19)

- The product is **Kaunta Book**: page title, installed-app name (`short_name` "Kaunta Book"), landing copy, install prompts, "Recorded in Kaunta Book", the counter's top bar before pairing, and the logo. **"Kaunta" stays** where it means the company/team that runs the platform (`/super` "Kaunta platform", "Kaunta set your password", "Kaunta has suspended…", the `kaunta` actor). Lowercase Kiswahili "kaunta" (counter) is unchanged.
- Logo: `scripts/brand-wordmark.mjs` added "Book" to `public/brand/lockup-*.svg`, outlined from Manrope ExtraBold (`scripts/font-outline.mjs`, a dependency-free WOFF reader) after the original kerned "Kaunta"; stacked lockup re-centred; the stale C2PA credentials removed. `og-dark-1200x630.png` redrawn from the new lockup. The source files in `kaunta-handoff/design/logo` are the originals.
- Why not plain "Kaunta": another Kenyan product (KRA/eTIMS compliance) uses it, including kaunta.vercel.app.

## How step 5 is put together

- Admin has its own local store (Dexie, `kaunta-admin`, or `kaunta-admin-demo` in demo mode). Screens read only from it.
- Admin writes are admin events (`src/data/adminEvents.ts`): applied locally, audited, queued in `adminOutbox`, sent by `AdminSync` (`src/admin/server.ts`) to `admin_push`; `admin_pull` brings rows back every 20 s.
- Sign-in is Supabase Auth (phone or email + password) linked to `people.auth_user_id`. Setup: `supabase/README.md`.
- Demo mode (no `.env.local`) runs on the full sample night at 02:14, generated in `src/domain/sampleDay.ts` so Today matches the seed totals exactly. It is separate from the counter demo (22:20 snapshot).
- PIN reset (R-PIN-2) by one-time code was replaced (see Staff access): owners and managers set PINs. The `pin_reset` event and columns remain for old data.

## Tests

- `npm test`: 594 unit and integration tests, including Postgres (PGlite) tests of the migrations (with and without `seed.sql`), of bar isolation and of bar codes (`supabase/multiBar.test.ts`).
- Counter UI and phone-sync tests pin the clock to the 22:20 snapshot; before 2026-11-11 they used the real clock and broke when the business day rolled over.
- `npm run test:e2e`: 17 Playwright tests (landing and counter at 360×800, admin at 390 px and desktop). `e2e/fullLoop.spec.ts` does the whole loop in one browser: add a bar, its code, presets, add a person, the code at the counter, one-time code → PIN, a sale, the sale in admin.

## Decisions made without the product owner (confirm)

- Undo after an approval decision: 2 minutes.
- One-time PIN reset codes: valid 24 hours; wrong codes count toward the PIN lockout.
- Rejecting a reported breakage write-off returns the bottles to stock (they must be found or charged).
- Comps and counter-reported breakage target a product and quantity, not an order line.
- Today flags a short shift (spec) even though the design shows 5 flags without it.
- `supabase/seed.sql` is still the counter's 22:20 snapshot; on a real server, Today shows only what counters recorded.
- One database for all bars (rows tagged with `bar_id`, isolation enforced by RLS), not one Supabase project per bar.
- Only owners can start a bar, and a person's first bar is still created in SQL (no public sign-up). An admin (not owner) can run several bars only if each bar's owner adds them.
- The landing page shows on `/` in a browser; the installed app goes straight to the way that device used last.
- The bar code is permanent (until an owner replaces it) and anyone holding it can join a phone to the bar; staff still need their PIN, an owner sees every phone in Staff & devices and can revoke it. One-time 6-digit pairing codes still work for owners who want tighter control.
- A device asks for the bar code once and remembers it; it does not ask every time the counter opens (speed at the counter).
- Owners sign in with a password (8+ characters), managers with a 4-digit PIN, as asked. Lock: 5 wrong tries, 15 minutes; the super admin can reset sooner.
- Staff PINs are kept readable for owners and managers (asked for). That is weaker than hash-only (R-PIN-2 said admins never see PINs): anyone with admin access to a bar knows every staff PIN. The digits never go to counter phones or into the audit log.
- An owner's password hash is on their `people` row in each of their bars, so phones can check it offline; a phone that is stolen and taken apart could be used to guess it offline.
- "Already signed in to admin on this browser" is trusted by the counter on the same browser (as the rest of counter login is checked on the device).
- Suspending is for counter staff and servers; managers are suspended by Kaunta removing their account (not built).
- A wrong sign-in never says whether the username exists.
- Managers' accounts are created by the super admin (bar detail) or by an owner for their own bars (Staff & devices → Managers). An owner can only add to another of their bars someone who already manages one of their bars.
- New Kiswahili strings for the landing page and bar switching (`landing.*`, `admin.bars.*`) need the same native-speaker review.
- First-run presets come with the seed's placeholder prices (not KES 0) so the counter can sell straight away; tracked presets start at 0 on the shelf and so show "Low" until stock is added. The chip says "Smirnoff Vodka" (seed name) where the design says "Smirnoff".

## Open questions (from `kaunta-handoff/CLAUDE.md`, still open)

- Kiswahili strings need a native speaker's review. Step 5 added about 300 (`src/i18n/admin.sw.json`).
- Tot size (30 ml), keg foam allowance (0), and whether "Spilled or broken" always needs approval (built: yes).
- Real prices: the seed's are placeholders.

## Not yet done

- Everything is committed: steps 1–5 in `3617480`, up to staff access in `b155a53`, stock, managers, stock per size and Kaunta controls in `48cb153`, the live server (accounts, Kaunta, keys) in `753587c`.
- **Deployed on Vercel** (2026-11-19): https://kaunta-book.vercel.app (project `kaunta`, account polyjosh; kaunta-app and kaunta-chi.vercel.app point to it too; kaunta.vercel.app belongs to another company). `vercel.json` (SPA rewrites, no-cache for `sw.js` and the OneSignal worker), `.vercelignore` (keys never uploaded). Vercel has `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (production + preview); add `VITE_ONESIGNAL_APP_ID` there too when it exists. Redeploy: `npx vercel deploy --prod`.
- **Migrations applied to the real Supabase project on 2026-11-18** (`npx supabase db push --remote`, no seed). Migration 4 needed `grant create on schema public to kaunta_api` around its owner changes (Supabase's migration role is not a superuser; PGlite is). Next: Kaunta's password (`set_super_password`), then `/super` → Add an owner.
- In the demo, all of this is in one browser's storage: anyone with access to the browser can read it. It is for testing, not for real bars' data.
- An owner's first bar is made by Kaunta at `/super` (on the server too); later bars with **Add a bar** in admin, within Kaunta's limit.
- Kaunta's password on a server is set in the SQL editor (`set_super_password`); there is no reset by email.
- The admin side has not been run against a live Supabase project, only against PGlite in tests.
- No settings screen: bar settings (foam allowance, void window, lockout) can only be changed in the database. The Kegs screen's foam note says "change it in settings".
