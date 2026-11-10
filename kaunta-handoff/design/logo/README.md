# Kaunta logo

**Concept: "the K-ruler".** The K's stem is a measuring ruler (the count). Three ember ticks (till, cash, shelf) feed into a diamond node where the K's arms meet: the point where the three numbers are reconciled. Tagline: **TILL · CASH · SHELF**. The wordmark is "Kaunta" with a capital K and **no dot or accent over the n**. The design reference is `Logo.dc.html` on the design canvas.

All SVGs are final artwork. The wordmark is converted to outlines (Manrope 800), so no font is needed. The ruler notches and the ring around the node are masks, so every file has a **transparent background** and works on any surface (the app icons and favicon are the exception: they include their own background).

## Pick by background

| Scheme | Use on | K, text | Ticks, node |
|---|---|---|---|
| `dark` | Counter Night `#15100C`, any dark surface | `#F7EEE4` | `#FF8F3F` |
| `light` | Day `#FAF6F1` / white, admin | `#22180F` | `#E0681A` |
| `ember` | ember `#FF8F3F` fills | `#1C1006` | `#FAF6F1` |
| `mono-black` | receipts, thermal printers, stamps, faxes | `#000` | `#000` |
| `mono-white` | photos, any colour you can't control | `#FFF` | `#FFF` |

## Files

```
svg/
  mark-{scheme}.svg                  mark only, 64×64 viewBox
  lockup-horizontal-{scheme}.svg     mark | divider | "Kaunta" over the tagline (login, marketing, documents)
  lockup-compact-{scheme}.svg        mark + "Kaunta", no tagline (app headers, top bars)
  lockup-stacked-{scheme}.svg        mark over "Kaunta" over the tagline (splash, empty states, About)
  wordmark-{scheme}.svg              "Kaunta" alone
  app-icon.svg                       512, Night tile, rounded (rx 112)
  app-icon-light.svg                 512, white tile, rounded
  app-icon-maskable.svg              512, full bleed, mark inside the 80% safe zone (PWA "maskable")
  favicon.svg                        64, simplified (no ruler notches or ticks, filled node) for small sizes
png/
  mark/mark-{scheme}-{64|128|256|512}.png
  lockup/lockup-horizontal-{scheme}-h{128|256}.png
  lockup/lockup-compact-{scheme}-h96.png
  lockup/lockup-stacked-{scheme}-w512.png
  lockup/wordmark-{scheme}-h128.png
  app-icon/app-icon-{48..512}.png, app-icon-light-{192|512}.png
  app-icon/app-icon-maskable-{192|512}.png, apple-touch-icon-180.png
  app-icon/favicon-{16|32|48}.png
  social/og-{scheme}-1200x630.png    link previews (WhatsApp, Open Graph)
favicon.ico                          16 + 32 + 48
```

## Where to use what in the app

- **Favicon:** `favicon.svg` (`<link rel="icon" type="image/svg+xml">`), with `favicon.ico` as the fallback.
- **PWA manifest:** `app-icon-192.png` and `app-icon-512.png` (`purpose: "any"`), plus `app-icon-maskable-192/512.png` (`purpose: "maskable"`). `apple-touch-icon-180.png` for iOS. `theme_color` and `background_color`: `#15100C`. These replace the old tally-gate `public/icon.svg` and `public/icon-maskable.svg`.
- **Counter (Night):** `lockup-stacked-dark.svg` on the login screen; `mark-dark.svg` in tight spots.
- **Admin top bar (Day):** `mark-light.svg` at 30px next to the venue name, or `lockup-compact-light.svg`. In Night mode, use the `-dark` files.
- **Receipts / print:** `lockup-horizontal-mono-black.svg`.
- **Inline in React:** prefer importing the SVG so it stays sharp. To recolour by theme, use the mark paths with `currentColor` for the K and `var(--ember)` for the ticks and node. Give each inline copy unique mask ids.

## Rules

- Minimum size: mark 24px (use `favicon.svg` below 32px), compact lockup 24px tall, horizontal lockup 40px tall (the tagline gets unreadable below that).
- Clear space around the logo = the width of the stem (12 of the 64 units).
- Ember appears only on the three ticks and the node. Don't recolour the K ember, rotate the mark, add shadows, or set "Kaunta" in another font.
- Never add a dot, accent or other mark over the n.
