# Kaunta Book

**Kaunta Book shows you when your till, your cash, and your shelf don't agree.**

Kaunta Book is a mobile-first, installable web app (PWA) for bars in Kenya. It is live at https://kaunta-app.vercel.app. Counter staff record what was served and confirm that it was paid for. Owners and managers see where money or stock went missing. Customers pay the bar directly by M-Pesa Till or cash. **Kaunta Book never takes or moves payments.**

It works in English and Kiswahili. It keeps working offline: every counter write goes to a local outbox first and syncs when the phone is back online.

---

## Contents

- [Who it is for](#who-it-is-for)
- [What it does](#what-it-does)
- [Quick start (browser demo)](#quick-start-browser-demo)
- [Running against Supabase](#running-against-supabase)
- [Scripts](#scripts)
- [Routes](#routes)
- [Project layout](#project-layout)
- [How it works](#how-it-works)
- [Testing](#testing)
- [Installing on a phone](#installing-on-a-phone)
- [Design rules every change must keep](#design-rules-every-change-must-keep)
- [Security notes](#security-notes)
- [Status and open questions](#status-and-open-questions)

---

## Who it is for

| Role | Where | What they do in Kaunta |
|---|---|---|
| **Counter staff** | Behind a dark, busy counter, on a cheap Android phone, often offline | Sign in with a 4-digit PIN. Record a sale in 2 taps (pay later) or 3 taps (paid). Take payments, request voids, close their shift |
| **Servers** | On the floor | Have no login. They appear in the server picker so each order shows who served it |
| **Managers** | Phone or laptop | Sign in with a username and 4-digit PIN. Manage products, stock, kegs and staff. Approve voids, comps and write-offs. Reconcile |
| **Owners** | Often from home | Sign in with a username and password. See everything managers see, plus managers, bar codes and more bars, all aimed at one question: *did I lose money today, and where?* |
| **Kaunta (super admin)** | `/super` | Creates owners and their first bar. Sets how many bars an owner may open. Suspends bars or staff. Resets PINs and passwords |

Owners and managers can also sell at the counter.

## What it does

**Counter** (Night theme, built for 360×800 screens)

- PIN login with lockout after 5 wrong tries.
- Sell: search or tap products, pick a size and a server, then pay now or later.
- Open orders, order detail, and payments: cash, M-Pesa, or part payments.
- Void requests. Staff can void their own sale for 5 minutes; after that, an admin must approve.
- Shift close with expected cash.
- Sync status. The sync pill is always visible and never red.

**Admin** (Day theme by default, phone first and responsive up to desktop)

- **Today**: served, collected, and money at risk, plus flags such as stock below zero or a short shift.
- **Approvals**: voids, comps, write-offs and sync conflicts, each with a 2-minute undo.
- **Reconciliation**: till and cash against what was recorded.
- **Sales feed** and **Audit log**, with who did what and when.
- **Products**: sizes, prices, pack sizes, counted or millilitre stock, stock per size, warning levels.
- **Add stock**: crates, boxes or single bottles.
- **Kegs**: expected cups against what was sold.
- **Staff & devices**: counter PINs (set by owners and managers), suspending and reinstating people, counter phones, bar codes, managers.
- **First run**: a new bar can add 12 preset products in one tap.
- **Many bars**: one account can run several bars. A bar switcher sits in the header.

**Platform (`/super`)**: totals for every bar, details for each bar, owners and managers, adding an owner, bar limits, suspension, and opening any bar's admin as Kaunta. Kaunta's own actions are hidden from the owners' and managers' logs.

## Quick start (browser demo)

You need Node.js 22 or later and npm.

```sh
npm install
npm run dev
```

Open the URL Vite prints, usually <http://localhost:5173>.

With no Supabase keys in `.env.local`, Kaunta runs as a **browser-only demo**. Sample data is generated locally and nothing leaves the browser.

| To try | Go to | Use |
|---|---|---|
| Counter for the sample bar | **Open the counter** | Bar code `BRKA-PUB2`. Staff PINs: Wanjiku `2580`, Otieno `1470`, Akinyi `3691`, Kiprop `8024`, Mwangi `5813` |
| Owner admin | **Owner or manager sign in** | `njeri` / `Baraka@2026` (owns Baraka Pub and Baraka Lounge) |
| Manager admin | **Owner or manager sign in** | `chebet` / `4826` (manages Baraka Pub) |
| Super admin | `/super` (link at the foot of the landing page) | Password `Kaunta@2026` |

The sample bar's counter is fixed at 22:20 and its admin at 02:14 on the sample night, so its numbers match the designs. Its counter sales do **not** appear in its admin. To watch a sale go all the way through, create a new bar at `/super` (or with **Add a bar** in admin): admin and counter then share one store, and sales show in Today and the Audit log straight away.

> Demo data lives in `localStorage` and IndexedDB in one browser. It is for testing, not for real bars' data.

## Running against Supabase

1. Copy `.env.example` to `.env.local` (it may already exist with empty values) and fill it in:

   ```sh
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   ```

   A project still on legacy keys can use its `anon` key instead. `VITE_SUPABASE_ANON_KEY` is read as a fallback. **Never** put the secret key or the `service_role` key here. Anything named `VITE_…` is built into the web page.

2. Apply the migrations in `supabase/migrations/` in file-name order:

   ```sh
   npx supabase login
   npx supabase link --project-ref <your project ref>
   npx supabase db push
   ```

3. In the SQL editor, set Kaunta's password once:

   ```sql
   select public.set_super_password('a long password only Kaunta knows');
   ```

4. Restart `npm run dev`, open `/super`, and add an owner with their first bar.

Full instructions, including the optional sample seed, how to attach an account to seeded people, and the full list of functions, are in [`supabase/README.md`](supabase/README.md).

> The server side is tested against real Postgres (PGlite) and runs on a live Supabase project (since 2026-11-18).

### Push notifications

Owners and managers are told when a request waits for them, stock runs low, or a shift starts or closes; counter phones when an order is still unpaid after 5 minutes and when an admin decides on their request. They go through [OneSignal](https://onesignal.com): put the **App ID** in `.env.local` (`VITE_ONESIGNAL_APP_ID`) and both the App ID and the **REST API Key** in Supabase Vault. Steps in [`supabase/README.md`](supabase/README.md#push-notifications-onesignal).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Type-checks, then builds to `dist/` |
| `npm run preview` | Serves the built `dist/` |
| `npm run app` | Builds and serves the installable PWA on port 4173, reachable from the local network |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | All unit and integration tests (Vitest), including the migrations in PGlite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:e2e` | Playwright end-to-end tests |
| `npm run seed:sql` | Regenerates `supabase/seed.sql` from `kaunta-handoff/data/seed.json` |

## Routes

| Path | What |
|---|---|
| `/` | Landing page: open the counter, sign in, choose a language, install |
| `/counter/login` | Bar code (first time on a device), then staff list and PIN |
| `/counter/sell`, `/counter/orders`, `/counter/orders/:id`, `/counter/orders/:id/void`, `/counter/shift/close`, `/counter/sync` | Counter screens |
| `/admin/*` | Owner and manager screens, plus `/admin/account` to change your own password or PIN |
| `/super/*` | Kaunta super admin |
| `/dev/components` | Component gallery (tokens, chips, sync pill) |

The installed app opens on whatever the device used last, so a counter phone goes straight to its counter.

## Project layout

```
kaunta-handoff/          Design handoff: the source of truth for rules and screens
  CLAUDE.md              Instructions, non-negotiables, build order
  docs/                  product-spec.md, domain-rules.md (R-… rule IDs), screens.md
  design/                tokens.css/json, screen designs (*.dc.html), logo files
  i18n/                  Original en/sw strings
  data/seed.json         Consistent sample night for Baraka Pub
src/
  App.tsx, main.tsx      Routes, providers, PWA registration
  components/            Icon/Logo, StatusChip, SyncPill
  lib/                   i18n, theme, formatKES, install prompt, sync helpers
  i18n/                  Admin and extra strings (en/sw)
  domain/                Pure business logic: types, orders, payments, voids, stock,
                         kegs, shifts, PINs, bar codes, business-day time, seed, presets
  data/                  Dexie stores, outbox, commands, admin events, demo server
  sync/                  Sync engine (ordered outbox, retry and backoff), transport, config
  counter/               Counter screens and session
  admin/                 Admin screens, bar switching, admin sync (server.ts)
  platform/              Accounts, bars and the super admin (demo directory and live actions)
  routes/                Landing page and component gallery
  styles/                App-wide CSS
supabase/
  migrations/            Postgres schema, RLS and functions, in order
  seed.sql               Sample data (counter's 22:20 snapshot)
  *.test.ts              PGlite tests of every function
  README.md              Server setup and API reference
e2e/                     Playwright: counter, admin, and the full loop
public/                  Favicon, PWA icons, Open Graph image
CLAUDE.md                Build log: what's done, decisions, open questions
```

## How it works

**Stack**: Vite, React 19, TypeScript, React Router, Dexie (IndexedDB), and `vite-plugin-pwa`. The backend is Supabase (Postgres functions only), and the font is Manrope, self-hosted.

**Local-first counter.** Screens read only from the phone's IndexedDB store. Every write becomes an event in an append-only outbox. The sync engine (`src/sync/engine.ts`) sends events in order with retry and backoff to `sync_push`, and pulls changes with `sync_pull`. The server applies each event once, by its event id. It never drops an event: anything it can't apply (a price mismatch, an archived product, a revoked phone) is kept and becomes an admin approval or review item.

**Admin events.** Admin changes are events too (`src/data/adminEvents.ts`). Each one is applied locally, audited, queued, sent with `admin_push`, and pulled back every 20 seconds with `admin_pull`. Each bar has its own local store (`kaunta-admin-<bar id>`), and all of them are deleted on sign-out.

**Server.** Phones and browsers never touch tables directly. Row-level security is on and table grants are revoked. The publishable key reaches only a few entry points:

- pairing: `pair_device`, `pair_with_bar_code`
- sync: `sync_push`, `sync_pull`
- sign-in: `account_sign_in`, `super_sign_in`
- `kaunta_admin(session, call, args)` and `kaunta_super(session, call, args)`, which check the session themselves.

Every bar-scoped row has a `bar_id`. Bar-scoped functions run as the `kaunta_api` role, and RLS keeps each call inside one bar.

**Joining a phone to a bar.** Each bar has a counter code of 6–12 characters, such as `BRKA-PUB2`. Look-alike characters (O/0, I/L/1) count as the same, so codes can't be confused. A phone enters the code once and then always opens to that bar's staff list. Owners can still hand out one-time 6-digit pairing codes, and they can revoke any phone.

**Money and time.** Money is stored as integer KES and displayed as `KES 1,250` with tabular figures. The business day starts at 06:00, so a sale at 02:00 belongs to the previous night.

## Testing

```sh
npm test           # 500+ Vitest tests
npm run test:e2e   # Playwright
```

- **Unit tests** cover the rules in `kaunta-handoff/docs/domain-rules.md`: the 06:00 business-day boundary, the 5-minute self-void window, PIN lockout, millilitre deductions, keg expected cups, shift expected cash, and M-Pesa variance. They also check the seed's totals (served 86,450 − collected 79,970 = 6,480 at risk).
- **Database tests** run every migration in [PGlite](https://pglite.dev) (Postgres in WebAssembly, no Docker). They cover sync, admin, accounts, bar isolation, bar codes, first run, and the app's own client calling as `anon`.
- **UI tests** use Testing Library with `fake-indexeddb`. Counter tests pin the clock to the 22:20 snapshot.
- **E2E**: the counter at 360×800, admin at 390 px and on desktop, and `e2e/fullLoop.spec.ts`. That test runs the whole loop in one browser: the super admin creates an owner and bar, the owner signs in and adds a menu and staff, a phone joins with the code, staff sign in with a PIN and make a sale, and the sale shows up in admin and the platform.

## Installing on a phone

`npm run app` serves the production build with the service worker on port 4173. Browsers allow installing only over HTTPS, except on `localhost`. To install on a real phone, deploy the `dist/` folder to an HTTPS host, or use a tunnel.

The landing page offers **Install Kaunta** where Chrome, Edge or Android support it, and shows the Share → Add to Home Screen hint on iPhone. Once installed, the app starts offline.

## Design rules every change must keep

These come from `kaunta-handoff/CLAUDE.md`:

- **Speed at the counter**: 2 taps to record a sale (pay later), 3 taps if paid, and no typing in the main flow.
- **Readable in a dark bar**: the Night theme on the counter, body text of 16 px or more, touch targets of 48 px or more (main actions 64 px, PIN keys 72 px).
- **Never ambiguous**: every status uses colour **and** icon **and** label. Ember, the accent colour, is for actions only.
- **Two languages**: every string comes from the i18n files, and layouts must survive strings about 30% longer.
- **Accountability**: every record keeps `recorded_by`, `server_id`, `device_id`, `created_at` and `synced_at`.
- **Offline is normal**: nothing blocks selling.

## Security notes

- The app ships only the publishable or `anon` key. No secret key belongs in the repo or the build.
- The server checks sign-in against bcrypt hashes. Counters check PINs and owner passwords offline against PBKDF2 hashes stored on the device.
- Staff PINs are readable by the bar's owners and managers, at the owner's request. They are never sent to counter phones and never written to the audit log.
- 5 wrong tries lock an account, a staff PIN, or the super admin for 15 minutes. Wrong pairing and bar codes are rate-limited (20 in 10 minutes).
- A failed sign-in never reveals whether the username exists.

## Status and open questions

All build steps in the handoff are done, along with the later additions: many bars, bar codes, PWA, accounts, staff access, stock per size, managers, and the super admin. The live build log, with every decision made without the product owner, is in [`CLAUDE.md`](CLAUDE.md).

Still open:

- The Kiswahili strings need review by a native speaker.
- Tot size (30 ml), keg foam allowance (0), and whether "Spilled or broken" always needs approval (currently yes).
- Real prices. The seed's prices are placeholders.
- Not yet run against a real Supabase project, and not yet deployed.
- No settings screen yet. Bar settings (foam allowance, void window, lockout) can only be changed in the database.

---

Private project. All rights reserved.
