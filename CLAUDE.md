# Kaunta: project status

Instructions, non-negotiables and the build order live in `kaunta-handoff/CLAUDE.md`; read it and `kaunta-handoff/docs/` first. This file records where the build stands.

Last updated: 2026-11-16 (staff access).

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
| + Super admin, owner accounts (username + PIN), owner-chosen bar codes | ✅ Demo (browser); server: codes only | see below; `src/platform/` |
| + Staff access: PINs set and seen by owners/managers, suspend, owners and managers sell at the counter | ✅ Demo; server: PINs + suspend | see below; `supabase/migrations/20261118000000_kaunta_staff_access.sql` |

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

## How step 5 is put together

- Admin has its own local store (Dexie, `kaunta-admin`, or `kaunta-admin-demo` in demo mode). Screens read only from it.
- Admin writes are admin events (`src/data/adminEvents.ts`): applied locally, audited, queued in `adminOutbox`, sent by `AdminSync` (`src/admin/server.ts`) to `admin_push`; `admin_pull` brings rows back every 20 s.
- Sign-in is Supabase Auth (phone or email + password) linked to `people.auth_user_id`. Setup: `supabase/README.md`.
- Demo mode (no `.env.local`) runs on the full sample night at 02:14, generated in `src/domain/sampleDay.ts` so Today matches the seed totals exactly. It is separate from the counter demo (22:20 snapshot).
- PIN reset (R-PIN-2) by one-time code was replaced (see Staff access): owners and managers set PINs. The `pin_reset` event and columns remain for old data.

## Tests

- `npm test`: 465 unit and integration tests, including Postgres (PGlite) tests of the migrations (with and without `seed.sql`), of bar isolation and of bar codes (`supabase/multiBar.test.ts`).
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
- Managers' admin accounts are created by the super admin (bar detail → Add a manager); owners can't create them yet.
- New Kiswahili strings for the landing page and bar switching (`landing.*`, `admin.bars.*`) need the same native-speaker review.
- First-run presets come with the seed's placeholder prices (not KES 0) so the counter can sell straight away; tracked presets start at 0 on the shelf and so show "Low" until stock is added. The chip says "Smirnoff Vodka" (seed name) where the design says "Smirnoff".

## Open questions (from `kaunta-handoff/CLAUDE.md`, still open)

- Kiswahili strings need a native speaker's review. Step 5 added about 300 (`src/i18n/admin.sw.json`).
- Tot size (30 ml), keg foam allowance (0), and whether "Spilled or broken" always needs approval (built: yes).
- Real prices: the seed's are placeholders.

## Not yet done

- Everything up to staff access is committed (steps 1–5 in `3617480`, the rest in the commit after it).
- Not deployed anywhere: installing on a phone needs the app on an HTTPS address.
- **The live server has not got accounts yet.** With `.env.local`, admin still signs in with Supabase Auth (phone/email + password) and there is no `/super` backed by the server. Server work needed: an accounts table (username, PIN hash, lockout), session tokens for the admin functions in place of `auth.uid()`, super admin functions behind a server-side password, and owner/bar creation (`create_owner`). Chosen bar codes are on the server already.
- In the demo, all of this is in one browser's storage: anyone with access to the browser can read it. It is for testing, not for real bars' data.
- A person's first bar still needs SQL by hand: the `bar` row and the owner's `people` row (`supabase/README.md`). Later bars: **Add a bar** in admin.
- Adding an existing admin to a second bar has no screen yet: today it is a `people` row in that bar with the same `auth_user_id` (SQL).
- The admin side has not been run against a live Supabase project, only against PGlite in tests.
- No settings screen: bar settings (foam allowance, void window, lockout) can only be changed in the database. The Kegs screen's foam note says "change it in settings".
