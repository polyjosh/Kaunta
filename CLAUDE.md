# Kaunta: project status

Instructions, non-negotiables and the build order live in `kaunta-handoff/CLAUDE.md`; read it and `kaunta-handoff/docs/` first. This file records where the build stands.

Last updated: 2026-11-10.

## Build order

| Step | Status | Where |
|---|---|---|
| 1. Tokens, theme, i18n, `formatKES`, StatusChip, SyncPill | ✅ Done | `src/lib`, `src/components`, `/dev/components` |
| 2. Data model, seed, local store, outbox | ✅ Done | `src/domain`, `src/data` |
| 3. Counter screens (login → sell → orders → payment → void → shift close → sync) | ✅ Done | `src/counter` |
| 4. Sync engine + Supabase server | ✅ Done | `src/sync`, `supabase/migrations/20261110000000_kaunta_sync.sql` |
| 5. Admin screens (Today → Approvals → Reconcile → Feed → Product → Stock → Kegs → Staff → Audit) | ✅ Done | `src/admin`, `supabase/migrations/20261111000000_kaunta_admin.sql` |
| 6. Empty and error states | ◐ Partly done | see below |

### Step 6 detail (`docs/screens.md` → Empty and error states)

- ✅ No open orders: counter Open orders.
- ✅ Offline with queued orders: sync pill and the Sync screen.
- ✅ Sync failure needing admin review: counter pill and needs-review card, and an item in admin Approvals.
- ✅ Search with no results: Sell.
- ✅ PIN locked: Login.
- ✅ Shift close blocked: Shift close.
- ⬜ **First run, no products**: admin Products / Today with preset chips of common Kenyan drinks and food (`Components.dc.html` → "First run · admin", strings `firstRun.*`). Not built.

## How step 5 is put together

- Admin has its own local store (Dexie, `kaunta-admin`, or `kaunta-admin-demo` in demo mode). Screens read only from it.
- Admin writes are admin events (`src/data/adminEvents.ts`): applied locally, audited, queued in `adminOutbox`, sent by `AdminSync` (`src/admin/server.ts`) to `admin_push`; `admin_pull` brings rows back every 20 s.
- Sign-in is Supabase Auth (phone or email + password) linked to `people.auth_user_id`. Setup: `supabase/README.md`.
- Demo mode (no `.env.local`) runs on the full sample night at 02:14, generated in `src/domain/sampleDay.ts` so Today matches the seed totals exactly. It is separate from the counter demo (22:20 snapshot).
- PIN reset (R-PIN-2) is end to end: an admin issues a one-time 6-digit code; the person types it at a counter and sets a new PIN (`pin_set` event).

## Tests

- `npm test`: 399 unit and integration tests, including Postgres (PGlite) tests of both migrations.
- `npm run test:e2e`: 18 Playwright tests (counter at 360×800, admin at 390 px and desktop).

## Decisions made without the product owner (confirm)

- Undo after an approval decision: 2 minutes.
- One-time PIN reset codes: valid 24 hours; wrong codes count toward the PIN lockout.
- Rejecting a reported breakage write-off returns the bottles to stock (they must be found or charged).
- Comps and counter-reported breakage target a product and quantity, not an order line.
- Today flags a short shift (spec) even though the design shows 5 flags without it.
- `supabase/seed.sql` is still the counter's 22:20 snapshot; on a real server, Today shows only what counters recorded.

## Open questions (from `kaunta-handoff/CLAUDE.md`, still open)

- Kiswahili strings need a native speaker's review. Step 5 added about 300 (`src/i18n/admin.sw.json`).
- Tot size (30 ml), keg foam allowance (0), and whether "Spilled or broken" always needs approval (built: yes).
- Real prices: the seed's are placeholders.

## Not yet done

- Nothing is committed to git yet.
- The admin side has not been run against a live Supabase project, only against PGlite in tests.
- No settings screen: bar settings (foam allowance, void window, lockout) can only be changed in the database. The Kegs screen's foam note says "change it in settings".
