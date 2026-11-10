# Kaunta — screen specs

Each screen lists: design file(s) in `design/screens/`, route, states, data, actions, rules (see `domain-rules.md`) and acceptance criteria (AC). Counter screens are 360×800, Night theme; admin screens are fluid (one column at phone width, multi-column from ~900px), Day theme.

Shared counter chrome: 60px top bar (`counter` surface, `line` bottom border) with back/identity on the left and the **sync pill** on the right. Bottom action area: `counter` surface, primary button 64px. Sheets slide up from the bottom over a 74% scrim, 22px top radius, close button 48×48, grabber.

Shared admin chrome: `AdminNav.dc.html` — bar name, business-day line, device sync summary, account; horizontal tab nav that scrolls at phone width; Approvals tab shows a count badge.

---

## 1. PIN login — `Login.dc.html`, `LoginPin.dc.html`, `LoginLocked.dc.html`
Route `/counter/login`. States: **names** (grid of staff with a PIN, 2 columns, 120px tiles, avatar initial on person colour + name; "Admin login" secondary at bottom) → **pin** (Not me back link, avatar, "Enter your 4-digit PIN", 4 dots, message line, keypad 3×4 at 72px; blank · 0 · ⌫ on the last row) → **locked** (yellow lock, countdown mm:ss, explanation, "Choose another name", "Admin unlock").
Rules: R-PIN-1, R-PIN-2. In the design, PIN `2580` succeeds; any other completes a wrong attempt.
AC: 4th digit submits automatically; wrong PIN clears dots and shows "Wrong PIN · N tries left" in warning colour; 5th wrong → locked view; lock state is visible on every device for that person.

## 2. Sell — `Sell.dc.html` (interactive), `SellSizes.dc.html`, `SellSw.dc.html`
Route `/counter/sell` (home after login). Layout top→bottom: top bar (recorder avatar+name → switch user; sync pill; Open orders button with count badge) · search field (48px) · category tabs (Beer, Spirits, Keg, Soft drinks, Food; selected = inverted cream pill) · product grid (2 columns, 100px tiles, scrolls) · order tray (server chip, table chip, item summary + total 30px, two buttons).
Tile states: default · in order (2px ember border + ember count badge) · several sizes ("5 sizes" + "from KES 80") · low stock (warning "3 left") · out of stock (dashed outline, box icon, "Out of stock", disabled).
Sheets: size picker (rows 60px: label, "N in order" badge, price), server picker (stays selected), table picker (1–12, Counter, Takeaway, No table), payment method (Cash / M-Pesa, 88px), this-order (− / + per line, Clear this order).
Actions: **Record & paid** (secondary, left, green check icon) → method sheet → toast. **Record (pay later)** (primary ember, right, 1.4× wider) → toast "Order #048 recorded · Table 4 · pay later". After recording: lines clear, order number increments, server stays, table resets.
Rules: R-SELL-1…6. Empty tray: buttons disabled, summary "Tap a drink to start an order".
AC: pay-later sale in 2 taps, paid sale in 3 taps; works offline; Kiswahili labels fit without truncating buttons; search filters across all categories by English or Kiswahili name.

## 3. Open orders — `Orders.dc.html`
Route `/counter/orders`. Header back to Sell. Summary "5 open · still to collect" + amount due. Filter chips: All · Mine · Over 30 min (with counts). Cards (oldest first): label, amount due ("KES 850 left" if part paid), order no · server · items or "KES 400 of 1,250 paid", time chip; part-paid cards show a progress bar; ageing cards (R-ORD-1) get a yellow border and filled yellow chip "46 min · open long". Bottom: "New order" primary.
Empty: receipt-with-check illustration, "No open orders".
AC: tapping a card opens order detail; ageing updates live each minute.

## 4. Order detail & payment — `OrderDetail.dc.html` (interactive), `OrderPay.dc.html`
Route `/counter/orders/:id`. Header: label + #no, "Open 22 min · since 21:58". Chips: Server, Recorded by. Due card: "Still to pay" 36px, progress bar, "KES 400 of 1,250 paid", Part paid chip. Lines: qty× in ember, name+size, "price each · time · recorder", line total, ⋮ menu (void line, move to new order). Payments list (green rows). Buttons: Add items (→ Sell with this order active), Split bill, "Void an item or this order" link. Bottom: "Confirm payment · KES 850".
Payment sheet: Amount (All of it / Part of it) · Method (Cash / M-Pesa / Split) · M-Pesa last 4 (optional, 4 chars, uppercase, helper text) · Split rows (cash + M-Pesa amounts) · "Confirm KES 850 received".
Split bill sheet: evenly between 2 / 3 / 4 people (shows each share), note on splitting by items.
Rules: R-ORD-2…5. AC: after a full payment the order disappears from Open orders and a toast confirms; a part payment updates the bar and due.

## 5. Void request — `Void.dc.html` (self window), `VoidApproval.dc.html` (needs admin)
Route `/counter/orders/:id/void`. Window banner: blue "You can void this yourself · closes in 3:12" or yellow "An admin needs to approve this". Scope radios: this line / whole order (amounts). Reasons (radio rows, 56px): Entered by mistake · Customer changed their mind (only if unopened) · Wrong size or product · Spilled or broken (write-off) · Something else (always admin). Button: "Pick a reason" (disabled) → "Void Tusker Lager" (red outline) or "Send to admin for approval" (yellow outline). Accountability footnote.
Rules: R-VOID-1…4. AC: countdown is live; when it hits 0 the screen switches to the approval variant without losing the selected reason.

## 6. Shift close — `ShiftClose.dc.html` (blocked), `ShiftCount.dc.html` (count)
Route `/counter/shift/close`. **Blocked**: yellow banner "3 orders are still open"; each order card with Pay / Void / Hand over (48px); disabled bottom button "Count cash · settle 3 orders first". **Count**: breakdown card (Float, + Cash sales, − Expenses, = Expected), Cash counted display (72px, ember border), live result chip (Matches green / Over blue / Short red), keypad with 00, bottom "Close shift & hand over cash", M-Pesa shift total note.
Rules: R-SHIFT-1, R-SHIFT-2, R-ORD-6. AC: result updates on every key press; closing records counted amount and result and logs out.

## 7. Sync status — `Sync.dc.html` (waiting), `SyncOffline.dc.html` (offline + needs review)
Route `/counter/sync` (tap the pill anywhere). Hero card in pill colours with big icon, headline, plain explanation, "Send now" when online. Needs-review card (yellow border) explains what an admin will decide and says staff need do nothing. List "Waiting to sync · 3" / "Saved on this phone · 3": what, amount · time · who, status chip. Footnote: nothing is lost on restart; order and authorship preserved.
Rules: R-SYNC-1…4. AC: no red anywhere; pill text matches the list count.

---

## 8. Today — `Today.dc.html` (desktop), `TodayPhone.dc.html`, `TodayPhoneSw.dc.html`
Route `/admin` (default for owner/admin). Prop/locale: en | sw. Title + "So far, up to 02:14 · the business day closes at 06:00". Dark hero: question "Did I lose money today?" + one-sentence answer generated from the data; three tiles: Sales served · Sales collected · **Money at risk** (yellow, links to Approvals / open orders). "How it was paid": stacked bar (cash green / M-Pesa blue + legend + amounts) and reconcile link. "Needs your attention": flag rows (tinted background, icon, title, explanation, action →) for negative stock, voids waiting, write-offs, price mismatches, keg short, shift short. "Sales by hour" bar chart (peak highlighted). "By server" bars → Sales feed.
Rules: R-DAY-1, R-DAY-4, R-STOCK-3, R-KEG-3, R-SELL-5. AC: numbers match seed (86,450 / 79,970 / 6,480; cash 31,570; M-Pesa 48,400); single column at 390px with nothing clipped; Kiswahili version uses the same layout.

## 9. Live sales feed — `Feed.dc.html`
Route `/admin/sales`. "Live" chip. Filter chips: Everything · Served · Paid · Voids · Needs review. Feed rows: time, status chip, what (order, label, method, M-Pesa last 4), who (server · recorded by · device), amount. Right column: By server table (Served, Collected, Not paid, orders count; totals row). Rows stream in as devices sync (newest on top, no layout jump).

## 10. Product editor — `Product.dc.html`
Route `/admin/products/:id`. Basics (name, Kiswahili name optional, category). Stock mode radio cards: Count / Millilitres (explanations). Sizes table: label, deduction (unit adapts to mode), price, Sold on/off switch; "+ Add a size"; info note on price changes and offline mismatches. Archive section (red outline). Side: In stock (amount, approx bottles, alert level, Add stock / Count shelf), Out of stock switch with live counter-tile preview, last change + history link. Save / Cancel at top.
Rules: R-STOCK-1, R-SELL-2, R-SELL-5.

## 11. Add stock — `Stock.dc.html`
Route `/admin/stock/new`. Supplier (optional), delivery note no. (optional), received by (auto). Rows per product: container description, − / × N / + steppers (48px), converted total ("= 2.25 L (2,250 ml)"), "Now 4,850 → 7,100 ml" (green when it fixes negative stock). Side summary with consequences (negative stock cleared, keg queued) and "Add to stock".
Rules: R-STOCK-2…4.

## 12. Kegs — `Kegs.dc.html`
Route `/admin/kegs`. Active keg card: level graphic (estimated), "~31 L left of 50 L", explanation, "Keg finished". Queue list. **Keg finished summary**: Expected / Recorded / Not recorded tiles, per-server table (mugs, jugs, cups), foam allowance note, actions Write off N cups · Mark as checked · See every sale from this keg.
Rules: R-KEG-1…3.

## 13. Approvals inbox — `Approvals.dc.html` (interactive)
Route `/admin/approvals`. Cards per item: kind chip (Void, Write-off, Comp, Price mismatch), title, amount, facts grid (asked by · when · device; recorded time; reason; server), **effect sentence** (what approving / rejecting will do), Approve (ember) / Reject (secondary; price mismatch uses "Accept KES 300" / "Mark KES 20 short"). Decided state shows result + who + Undo (for a short grace period; then final, audit-logged).
Rules: R-VOID-2…4, R-COMP-1, R-SELL-5, R-SYNC-3.

## 14. Reconciliation — `Recon.dc.html` (interactive)
Route `/admin/reconcile/:day`. Cash per shift table: Float, + Cash sales, − Expenses (with notes), = Expected, Counted, Result chip (Matches / Short / Over / Shift open). M-Pesa for the day: Recorded in Kaunta (count, how many with code) · Till total input (admin types it) · live variance tile; when recorded > till, list M-Pesa payments without a code first. "Close the business day" enabled when all shifts closed and till entered.
Rules: R-SHIFT-2, R-DAY-3.

## 15. Staff, servers & devices — `Staff.dc.html`
Route `/admin/staff`. People table: avatar, name, role, login chip (PIN · PIN locked · Phone + password · Server only), last active, actions (Unlock, Reset PIN, Archive). Devices: name, model, paired by/when, last sync, status chip, Revoke (red outline); revoked devices greyed with reason. Add a counter phone: "Make pairing code" → big 6-digit code, expiry countdown, name field, cancel.
Rules: R-PIN-1, R-PIN-2, R-DEV-1, R-DEV-2.

## 16. Audit log — `Audit.dc.html`
Route `/admin/audit`. Read-only notice. Filters: day, person, device, search; kind chips (Sales, Payments, Voids & write-offs, Products & prices, Stock, Logins & devices, Shifts). Timeline rows: time, summary, before → after (strikethrough → bold), who · device (including "saved offline 02:02, synced 02:11"), kind chip. Count + Download as CSV.
Rules: R-AUD-1, R-AUD-2.

---

## Empty and error states

| State | Where | Design |
|---|---|---|
| First run, no products | Admin products / Today | `Components.dc.html` → "First run · admin": preset chips of common Kenyan drinks & food (all ticked), "Add 11 products", "Start from blank" |
| No open orders | Counter Open orders | `Components.dc.html` and `Orders.dc.html` empty branch |
| Offline with queued orders | Counter, everywhere | Pill "Offline · 3 saved" + `SyncOffline.dc.html`; toast "Saved on this phone…" |
| Sync failure needing admin review | Counter + Admin | Pill "1 needs admin" (yellow), needs-review card on `SyncOffline.dc.html`, item in Approvals |
| Search with no results | Sell | "Nothing matches" + hint |
| PIN locked | Login | `LoginLocked.dc.html` |
| Shift close blocked | Shift close | `ShiftClose.dc.html` |
