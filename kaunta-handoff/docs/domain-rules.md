# Kaunta — data model and business rules

Rule IDs (e.g. **R-DAY-1**) are referenced from `screens.md`; write a unit test per rule.

## Conventions

- Money: integer KES. `formatKES(1250) → "KES 1,250"`. Never floats, never decimals.
- Volumes: integer millilitres. Counts: integer units.
- Time: store UTC instants; display in Africa/Nairobi (UTC+3, no DST).
- IDs: client-generated UUIDv7 (sortable) so counters can create records offline.
- Every mutable business record carries: `recorded_by` (person id), `device_id`, `created_at` (device clock), `synced_at` (server, nullable while offline).
- Records are never hard-deleted. Voids, write-offs and archives are state changes with their own audit events.

## Entities

```
Bar            id, name, timezone="Africa/Nairobi", day_start="06:00", self_void_minutes=5,
               ageing_minutes=30, pin_attempts=5, lockout_minutes=5, keg_foam_allowance_cups=0
Person         id, name, initial, colour, role: owner|admin|counter|server, pin_hash?, pin_locked_until?,
               failed_pin_attempts, archived_at?
Device         id, name ("Counter 1"), model, paired_at, paired_by, revoked_at?, revoked_reason?, last_sync_at
PairingCode    code (6 digits), expires_at (10 min), used_at?, created_by
Category       id, name_en, name_sw, sort   (Beer, Spirits, Keg, Soft drinks, Food)
Product        id, category_id, name, name_sw?, stock_mode: count|ml, stock_qty (int; units or ml),
               low_stock_at?, manual_out_of_stock: bool, archived_at?
ProductSize    id, product_id, label_en, label_sw, deduct (units or ml), price_kes, enabled, sort
Keg            id, product_id, code ("K-07"), volume_ml, cup_ml (deduct of the base mug size),
               status: queued|active|finished, tapped_at?, finished_at?, finished_by?
Order          id, short_no (#047, per business day), label ("Table 4" | "Mzee in blue" | "Counter"),
               server_id, recorded_by, device_id, business_day, status: open|paid|voided,
               created_at, handed_over_to?
OrderLine      id, order_id, product_id, size_id, qty, unit_price_kes (price at time of sale),
               recorded_by, created_at, status: active|void_pending|voided, keg_id?
Payment        id, order_id, method: cash|mpesa, amount_kes, mpesa_ref_last4?, recorded_by, device_id, created_at
               (a split payment = two Payment rows created together)
ApprovalItem   id, kind: void|comp|write_off|price_mismatch, target (order/line/product), amount_kes,
               reason_code, requested_by, requested_at, status: waiting|approved|rejected, decided_by?, decided_at?
StockMovement  id, product_id, delta (units or ml), reason: sale|void_return|write_off|delivery|count|keg_tap,
               ref_id, recorded_by, created_at
Delivery       id, supplier?, note_no?, received_by, lines[{product_id, container_label, container_qty, per_container, total}]
Shift          id, person_id, device_id, opened_at, float_kes, closed_at?, counted_cash_kes?,
               expenses[{label, amount_kes}], result_kes? (counted − expected)
DayClose       business_day, till_total_kes (entered by admin), recorded_mpesa_kes, closed_by, closed_at
AuditEvent     id, at, actor_id|"system", device_id, kind, summary, before?, after?, ref_id  (append-only)
```

## Business day

- **R-DAY-1** A business day runs from 06:00 to 06:00 next day (Africa/Nairobi). A sale at 02:14 on Wed belongs to Tuesday's day.
- **R-DAY-2** Order short numbers (#001…) restart each business day and are allocated per device range or reconciled on sync so two offline counters never show the same number to staff (suggested: server assigns final numbers; devices show a provisional number prefixed by device until synced, e.g. `#2-014`). Designs show the final form `#047`.

## Selling

- **R-SELL-1** Tapping a product with one size adds 1 of that size. Tapping a product with >1 enabled size opens the size picker; picking a size adds 1 and closes the picker.
- **R-SELL-2** A product is shown as out of stock (not tappable) when `manual_out_of_stock` is true. Stock count reaching 0 or below does **not** block selling (the shelf may be wrong); it raises the "negative stock" flag instead (**R-STOCK-3**).
- **R-SELL-3** The chosen server persists between orders on that device until changed or the user logs out.
- **R-SELL-4** "Record (pay later)" creates an `open` order. "Record & paid" asks Cash / M-Pesa, then creates the order and a Payment for the full total; order becomes `paid`.
- **R-SELL-5** `unit_price_kes` is copied from the size at the time of sale on the device. If the server's price differed at that instant (offline counter with a stale price), the sale is kept as recorded and a `price_mismatch` ApprovalItem is created for `(server_price − recorded_price) × qty`.
- **R-SELL-6** Low stock warning on the tile ("3 left") when `stock_qty ≤ low_stock_at` (count mode only).

## Open orders and payments

- **R-ORD-1** An order is "ageing" when open for more than `ageing_minutes` (30). Show yellow border + filled time chip; never red.
- **R-ORD-2** `due = sum(active lines) − sum(payments)`. Order is `paid` when due ≤ 0. Part paid when 0 < paid < total.
- **R-ORD-3** Payment amount defaults to full due; "Part of it" records a smaller amount. A split payment must add up to the amount received.
- **R-ORD-4** M-Pesa last 4 characters are optional, uppercase A–Z/0–9, exactly 4 if present. Used later to match the till statement.
- **R-ORD-5** Split bill evenly: each share = `ceil(due / n)`; shares are recorded as separate part payments. Split by items = move lines to a new order.
- **R-ORD-6** Hand over: at shift close an open order can be reassigned to the next person who logs in on that device; logged as an audit event.

## Voids, comps, write-offs

- **R-VOID-1** A line (or whole order) can be self-voided by the person who recorded it within `self_void_minutes` (5) of the line's `created_at`, for reasons *Entered by mistake*, *Customer changed their mind*, *Wrong size or product*.
- **R-VOID-2** Outside the window, or reason *Something else*, the void becomes an ApprovalItem; the line goes to `void_pending` and still counts toward the order total until approved.
- **R-VOID-3** Reason *Spilled or broken* is a **write-off**: stock is not returned; always needs approval.
- **R-VOID-4** Approved void returns stock (`void_return`). Rejected void restores the line to `active`.
- **R-COMP-1** A comp (on the house) is requested by staff and approved by admin; amount is written off, stock is deducted.

## Stock

- **R-STOCK-1** Count mode: each sale deducts `size.deduct` units × qty. ml mode: each sale deducts `size.deduct` ml × qty from one pool (e.g. Kenya Cane: Tot 30 ml, 250ml, 350ml, 750ml, 1 Litre 1000 ml).
- **R-STOCK-2** Deliveries are entered as containers: `total = container_qty × per_container` (3 × 750 ml = 2,250 ml; 1 × crate of 25 = 25 bottles).
- **R-STOCK-3** Negative stock (`stock_qty < 0`) appears as a flag on Today until a delivery or count brings it ≥ 0.
- **R-STOCK-4** Kegs don't add to `stock_qty` directly: a delivered keg enters the keg queue (`queued`).

## Kegs

- **R-KEG-1** One keg per keg product is `active`. "Keg finished" (counter or admin) marks it `finished` and activates the next `queued` keg.
- **R-KEG-2** Remaining (estimated) = `volume_ml − Σ(line.qty × size.deduct)` for lines linked to the keg. Shown as "~31 L left" — it's an estimate from sales.
- **R-KEG-3** On finish: `expected_cups = volume_ml / cup_ml` (50,000 / 500 = 100). `recorded_cups = Σ(qty × deduct) / cup_ml` (a 2 L jug = 4 cups). `short = expected − recorded − foam_allowance`. If `short > 0`, flag on Today with value `short × mug_price`.

## Shifts and reconciliation

- **R-SHIFT-1** A shift cannot be closed while it has open orders recorded on it; each must be paid, voided (or void requested) or handed over.
- **R-SHIFT-2** `expected_cash = float + cash_payments_in_shift − expenses`. `result = counted − expected` → *Matches* (0), *Over* (> 0, blue), *Short* (< 0, red, "Short KES 300").
- **R-DAY-3** M-Pesa for the day: `variance = recorded_mpesa − till_total`. > 0 "Recorded but not on the till" (list M-Pesa payments without a code first). < 0 "On the till but not recorded". The admin can close the day with a variance; it's kept on record.
- **R-DAY-4** Today: `served = Σ active line totals in business day`; `collected = Σ payments`; `money_at_risk = served − collected` (equals open-order dues when no voids are pending).

## PIN and devices

- **R-PIN-1** 4-digit PIN. After `pin_attempts` (5) consecutive wrong PINs, the person is locked for `lockout_minutes` (5) on all devices; an admin can unlock. Lock and unlock are audit events.
- **R-PIN-2** Admin "Reset PIN" issues a one-time code; the person sets a new PIN at the counter. Admins never see PINs. Store only a salted hash (and verify offline against a hash synced to paired devices).
- **R-DEV-1** Pairing: admin creates a 6-digit code valid 10 minutes, single use. The new device enters it to receive a device token.
- **R-DEV-2** Revoking a device invalidates its token immediately. Unsynced events it sends afterwards are quarantined as `needs review`, not dropped.

## Offline sync

- **R-SYNC-1** Every counter write is an event appended to the local outbox and applied to the local store immediately (optimistic).
- **R-SYNC-2** Events are sent in creation order, idempotently (event id), with retry and exponential backoff. The pill shows: *Synced*; *N waiting* (online, queue > 0); *Sending N…*; *Offline · N saved* (no network, calm grey); *N needs admin* (server rejected/flagged; yellow).
- **R-SYNC-3** Server conflicts never silently change what staff recorded. They become ApprovalItems (price mismatch, product archived meanwhile, sale from a revoked device).
- **R-SYNC-4** The app must keep full counter functionality with no network for at least one business day of data.

## Audit log

- **R-AUD-1** Append-only. Events for: sales, line changes, payments, voids/comps/write-offs and decisions, price/product changes (with before → after), stock movements and deliveries, logins, PIN locks/resets, device pairing/revocation, shift open/close, day close.
- **R-AUD-2** Filterable by day, person, device, kind, and free text (order no., product, M-Pesa last 4). Exportable as CSV.
