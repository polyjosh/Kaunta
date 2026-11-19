# Kaunta brag video: plan

**What it is:** a phone app that helps bars in Kenya record what was served and confirm it was paid. It never takes payments.
**Who it's for:** bar owners who suspect money goes missing between the counter, the till and the shelf, and the counter staff who serve all night.
**What sets it apart:** a sale in 3 taps on a cheap phone, it keeps selling with no signal, and it answers "Did I lose money today?" in plain words.
**Most impressive claim:** a paid sale takes exactly 3 taps (tested in `e2e/counter.spec.ts`).
**Visual hook:** the sample night's real numbers. Served KES 86,450, collected KES 79,970: where did KES 6,480 go?
**Real UI shown:** the counter's Sell screen on a phone (screenshots of the running app in demo mode, 360×800): Guinness → Record & paid → M-Pesa → "Order #049 recorded · paid by M-Pesa". Offline sale. Admin's Today on desktop at 02:14.
**Tone:** `default` (punchy, clean), on Kaunta's Counter Night palette.
**Share caption:** see `share-copy.txt`.

**Privacy:** every name and figure on screen is the project's fictional sample bar (Baraka Pub; staff Wanjiku, Otieno, Akinyi…). No real people, keys or URLs.

## Visual identity

Kaunta's own tokens (`kaunta-handoff/design/tokens.css`, Night): ground #15100C, text #F7EEE4, ember #FF8F3F for actions only, warning yellow #F2C94C for money at risk (as in the app's Today card). Manrope 600/800 from the project's own `@fontsource/manrope`. The horizontal and stacked logo lockups from `public/brand/`.

## Music

120 BPM (beat 0.5 s, bar 2 s), A minor: Am–F–C–G, one chord per bar. Pad and hats under the hook; kick and bass drop in at the reveal (3.5 s). Taps are soft pitched ticks on the beat. Low filtered swells into each cut. The final chord rings out.

## Storyboard (22.5 s, 30 fps, 675 frames, every cut on a beat)

| # | Time | Scene | On screen |
|---|---|---|---|
| 1 | 0.0–3.5 | Hook | "Served KES 86,450" counts up · "Collected KES 79,970" counts up · "So where's KES 6,480?" in warning yellow |
| 2 | 3.5–8.0 | Reveal | Horizontal lockup, then "Kaunta shows you when your till, your cash and your shelf don't agree." |
| 3 | 8.0–13.0 | Highlight 1 | "A sale in 3 taps." Phone with the real Sell screen; taps on beats at 9.0, 10.0, 11.0 (Guinness, Record & paid, M-Pesa) with a ring and a 1-2-3 counter; toast "Order #049 recorded · paid by M-Pesa" |
| 4 | 13.0–16.5 | Highlight 2 | "No signal? Keep selling." Real offline screen (Offline · 3 saved, "Saved on this phone…"); "Nje ya mtandao. Endelea kuuza." |
| 5 | 16.5–20.0 | Highlight 3 | "02:14 · the owner, at home" over the real admin Today on desktop, slow push-in to "Did I lose money today?" and Money at risk KES 6,480 |
| 6 | 20.0–22.5 | Outro | Stacked lockup · "Record what was served. Confirm it was paid." · "English & Kiswahili · Works offline · Never takes payments" |

Transitions: old scene out (0.25 s), dip through the ground, new scene in (0.3 s).
