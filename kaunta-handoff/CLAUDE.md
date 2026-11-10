# Kaunta — instructions for Claude Code

Kaunta is a mobile-first PWA that helps bars in Kenya record what was served and confirm that it was paid for. It is **not a payment app**: customers pay the bar directly (M-Pesa Till or cash). The product promise to owners: *"Kaunta shows you when your till, your cash, and your shelf don't agree."*

Read these before writing code, in this order:

1. `docs/product-spec.md` — users, principles, what each role needs.
2. `docs/domain-rules.md` — data model and every business rule (business day, void window, PIN lockout, stock modes, kegs, reconciliation, offline sync). **These rules are the source of truth; the designs illustrate them.**
3. `docs/screens.md` — one section per screen: purpose, states, data, actions, acceptance criteria, and which design file to match.
4. `design/README.md` — how to read the `.dc.html` design files and the tokens.
5. `design/logo/README.md` — the logo files (mark, lockups, app icons, favicon) and which to use on each background. Use these files; don't redraw the logo.

## Non-negotiables (from the design principles)

- **Speed at the counter.** Recording a sale is 2 taps (pay later) or 3 taps (paid). No typing anywhere in the main counter flow.
- **Readable in a dark bar.** Counter UI uses the *Counter Night* theme. Body text ≥ 16px (17px default), money much larger. Touch targets ≥ 48px; main actions 64px; PIN keys 72px; ≥ 8px between targets.
- **Never ambiguous.** Every status = colour **+** icon **+** label. Never colour alone. Ember (the accent) is for actions only — never a status.
- **Two languages.** Every user-facing string comes from `i18n/en.json` / `i18n/sw.json`. No hard-coded copy. Layouts must survive strings ~30% longer (wrap, don't truncate buttons; ellipsis only on names/summaries).
- **Accountability without steps.** Every record stores `recorded_by`, `server_id`, `device_id`, `created_at` (device time) and `synced_at`. Show who/when on orders, lines and payments.
- **Offline is normal.** All counter writes go to a local outbox first and sync in order. The sync pill is always visible and never red. Offline must never block selling.
- **Money** is stored as integer KES (no decimals, no floats). Display as `KES 1,250` with tabular figures (`font-variant-numeric: tabular-nums`). Shortfalls are written as words ("Short KES 300"), not bare minus signs. Negative stock may be shown with a minus because it's a count, not money.

## Suggested stack (change it if you prefer — nothing in the design depends on it)

- Frontend: Vite + React + TypeScript, installable PWA (service worker, manifest), routes for `/counter/*` and `/admin/*`.
- Local data on counters: IndexedDB (e.g. Dexie) with an append-only **outbox** table; UI reads from the local store.
- Backend: Postgres + an HTTP API (or Supabase). Server is authoritative for prices, stock and approvals; it accepts offline events with their original timestamps.
- i18n: load `i18n/*.json`; keys are flat dot-paths; `{name}` placeholders; plural forms use `_one` / `_other` suffixes.
- Styling: import `design/tokens.css`; themes switch via `data-theme="night" | "day"` on `<html>`. Counter routes force `night`; admin defaults to `day` with a toggle.
- Font: Manrope (Google Fonts) 500/600/700/800. Self-host it for offline use.

## Build order (each step shippable and testable)

Progress is tracked in the project root `CLAUDE.md` (status, decisions, open questions).

1. ✅ Tokens, font, theme switch, i18n loader, money formatter (`formatKES`), status-chip and sync-pill components.
2. ✅ Data model + seed data (`data/seed.json`) + local store + outbox.
3. ✅ Counter: PIN login & lockout → Sell → Open orders → Order detail & payment → Void → Shift close → Sync screen.
4. ✅ Sync engine: ordered outbox, retry with backoff, conflict rules from `domain-rules.md` (price mismatch → approval item).
5. ✅ Admin: Today → Approvals → Reconciliation → Sales feed → Product editor → Add stock → Kegs → Staff & devices → Audit log.
6. ◐ Empty/error states listed in `docs/screens.md` (first run presets, no open orders, offline with queue, sync needs review). Done: no open orders, offline with queue, sync needs review, search with no results, PIN locked, shift close blocked. Left: first run presets.

## Testing expectations

- Unit tests for every rule in `domain-rules.md` (business-day boundary at 06:00, 5-minute self-void window, lockout after 5 wrong PINs, ml deductions, keg expected cups, shift expected cash, M-Pesa variance).
- Use `data/seed.json`: its numbers are internally consistent with the designs (e.g. served 86,450 − collected 79,970 = money at risk 6,480 = sum of open orders). Tests can assert those totals.
- Playwright: 360×800 viewport for counter flows; assert a sale is recordable in ≤ 3 taps and works with the network offline.
- Accessibility: real `<button>`/`<a>`/`<input>` with labels; icon-only buttons have `aria-label`; text contrast ≥ 4.5:1 (tokens already pass).

## Things to confirm with the product owner (don't guess silently)

- Kiswahili strings were written by the designer and need review by a native speaker before launch.
- Tot size (30 ml in the seed), foam allowance for kegs (0 in the seed), and whether "Spilled or broken" should always need approval (designed: yes).
- Real prices — the seed prices are realistic placeholders.
