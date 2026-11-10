# Design files

The live design canvas (all artboards, interactive where marked) is the Kaunta Design artifact on claude.ai. Ask the product owner for access if you can't open it: https://claude.ai/artifact/SqtShgsgKjFveeEXy5EpKs

`screens/` holds the source of every artboard as `.dc.html` files. They are readable HTML with inline styles — treat them as the **visual reference** for spacing, sizes, colours and copy, not as production code:

- `<x-dc>` wraps the markup. `{{name}}` is a value computed in the `renderVals()` method of the `<script type="text/x-dc">` block at the bottom of each file — read that block to see sample data and interaction logic.
- `<sc-for list="{{items}}" as="item">` repeats; `<sc-if value="{{flag}}">` branches.
- `<dc-import name="Sell" language="sw">` mounts another file (`Sell.dc.html`) with props — e.g. `SellSw.dc.html` is the Sell screen in Kiswahili, `OrderPay.dc.html` is Order detail with the payment sheet open.
- `./support.js` is the design tool's runtime; it is not part of the product.

| File | Screen |
|---|---|
| Main.dc.html | Design system: foundations (colour, type, spacing, radius, touch) |
| Components.dc.html | Design system: components (buttons, chips, sync pill, tiles, order cards, toasts, staff picker, PIN pad, lockout, number entry, empty states) |
| Login / LoginPin / LoginLocked | 1 PIN login |
| Sell / SellSizes / SellSw | 2 Sell (EN, size picker, Kiswahili) |
| Orders | 3 Open orders |
| OrderDetail / OrderPay | 4 Order detail, payment |
| Void / VoidApproval | 5 Void request |
| ShiftClose / ShiftCount | 6 Shift close |
| Sync / SyncOffline | 7 Sync status |
| AdminNav | Admin top bar (shared) |
| Today / TodayPhone / TodayPhoneSw | 8 Today dashboard |
| Feed | 9 Live sales feed |
| Product | 10 Product editor |
| Stock | 11 Add stock |
| Kegs | 12 Kegs |
| Approvals | 13 Approvals inbox |
| Recon | 14 Reconciliation |
| Staff | 15 Staff, servers and devices |
| Audit | 16 Audit log |

Tokens: `tokens.css` (CSS variables for both themes) and `tokens.json` (same values plus type scale, touch sizes, status → icon/label map and icon paths).

Logo: `logo/` holds the final mark, lockups, wordmark, app icons, favicon and social images for every background, as SVG and PNG. See `logo/README.md` for which file to use where.
