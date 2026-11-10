# Kaunta — product spec

## What it is

A record-keeping and accountability tool for local bars in Kenya. Staff record what was served and confirm that payment was received. Customers pay the bar directly by M-Pesa Till or cash; Kaunta never moves money.

**Promise to owners:** "Kaunta shows you when your till, your cash, and your shelf don't agree."

## Users

| Role | Where / how | What they need |
|---|---|---|
| Counter staff (main user) | Behind a dark, loud, crowded counter at night; cheap Android phone (360×800, sometimes cracked), one-handed, wet hands, patchy internet; often more comfortable in Kiswahili | Record a sale in 2–3 taps, confirm payments, see open orders, close a shift |
| Admin / manager | Mostly phone, sometimes laptop | Products, prices, stock, kegs, staff, devices; approve voids/comps/write-offs; reconcile |
| Owner | Phone, often from home | A fast answer to "did I lose money today, and where?" |

Roles in the system: `owner`, `admin`, `counter` (has a PIN, can log in at a counter), `server` (no login; appears in the server picker only).

## Design principles (priority order)

1. **Speed at the counter.** 2–3 taps per sale, no typing in the main flow.
2. **Readable in a dark, busy bar.** Dark theme on the counter, high contrast, ≥16px body, big money, ≥48px targets (main actions 64px).
3. **Never ambiguous.** Status = colour + icon + label (pending, paid, part paid, voided, written off, out of stock, offline, needs review, short).
4. **Plain language, two languages.** English and Kiswahili for every label; allow ~30% longer strings; no accounting jargon.
5. **Accountability is visible but not heavy.** Who served, who recorded, when — always shown, never an extra step.
6. **Offline is normal.** Calm, always-visible sync pill (Synced / 3 waiting / Offline). No alarming red banners for normal offline use.

## Visual direction

Warm and confident, not fintech/SaaS. "A well-lit counter at night": deep warm dark ground (Counter Night), one ember accent for primary actions only, clear semantic colours. Does not imitate Safaricom, M-Pesa or any bank. One sans-serif (Manrope) with tabular figures. Light theme (Day) for admin/owner, with Night as an option. Full tokens: `design/tokens.json`.

## Screens (16)

Counter (mobile, Night): 1 PIN login · 2 Sell · 3 Open orders · 4 Order detail & payment · 5 Void request · 6 Shift close · 7 Sync status.

Admin & owner (mobile first, responsive to desktop, Day): 8 Today · 9 Live sales feed · 10 Product editor · 11 Add stock · 12 Kegs · 13 Approvals · 14 Reconciliation · 15 Staff, servers & devices · 16 Audit log.

Plus: design system, empty and error states (first run with presets, no open orders, offline with queued orders, sync needing admin review). Sell and Today are designed in both English and Kiswahili.

Details per screen: `docs/screens.md`.
