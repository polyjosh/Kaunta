import { useId } from 'react';
import tokens from '../../kaunta-handoff/design/tokens.json';

const extra = {
  // The "Over" shift result, as drawn in ShiftClose.dc.html.
  'arrow-up-circle': 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z M12 16V8 M8.5 11.5L12 8l3.5 3.5',
  more: 'M12 5h.01 M12 12h.01 M12 19h.01',
  // Controls drawn inline in the screen designs (Login.dc.html, Sell.dc.html).
  'chevron-left': 'M15 18l-6-6 6-6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M6 15l6-6 6 6',
  close: 'M18 6L6 18 M6 6l12 12',
  minus: 'M5 12h14',
  plus: 'M12 5v14 M5 12h14',
  check: 'M20 6L9 17l-5-5',
  list: 'M4 6h16M4 12h16M4 18h10',
  // Comp (on the house), as drawn in Approvals.dc.html.
  gift: 'M3 8h18v4H3z M5 12v9h14v-9 M12 8v13 M12 8c-2-4-6-4-6-1s6 1 6 1zm0 0c2-4 6-4 6-1s-6 1-6 1z',
} as const;

/**
 * The Kaunta mark, "the K-ruler" (kaunta-handoff/design/logo): the ruler stem
 * and arms in the theme's logo ink, the three ticks and the node in its
 * ember. Paths from svg/mark-*.svg; each copy has its own mask ids.
 * Decorative by default (the name sits next to it); give `label` when alone.
 */
export function Logo({ size = 30, label }: { size?: number; label?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      className="k-logo"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <mask id={`${id}s`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <path d="M7 16h7M7 26h7M7 36h7M7 46h7" stroke="#000" strokeWidth="2.6" strokeLinecap="round" />
      </mask>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <circle cx="35" cy="34" r="8.5" fill="#000" />
      </mask>
      <rect x="9" y="6" width="12" height="52" rx="6" fill="var(--k-logo-ink)" mask={`url(#${id}s)`} />
      <path d="M24.5 27h3.5M24.5 34h3.5M24.5 41h3.5" stroke="var(--k-logo-ember)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M38 31L54 9M38 37L53 56" stroke="var(--k-logo-ink)" strokeWidth="10" strokeLinecap="round" mask={`url(#${id}a)`} />
      <path d="M35 28.5l5.5 5.5-5.5 5.5-5.5-5.5z" stroke="var(--k-logo-ember)" strokeWidth="2.6" strokeLinejoin="round" />
    </svg>
  );
}

/** The logo with the wordmark (outlined artwork, so no font needed), in the scheme for the background. */
/** lockup-horizontal-*.svg viewBox: 624.26 × 128 (Kaunta Book; scripts/brand-wordmark.mjs added "Book"). */
const HORIZONTAL_RATIO = 624.26 / 128;

export function Lockup({ kind, scheme, height }: { kind: 'stacked' | 'horizontal'; scheme: 'dark' | 'light'; height: number }) {
  // Intrinsic sizes from the SVG viewBoxes, so the space is kept before the image loads.
  const ratio = kind === 'stacked' ? 410.87 / 241.4 : HORIZONTAL_RATIO;
  return <img className="k-lockup" src={`/brand/lockup-${kind}-${scheme}.svg`} alt="Kaunta Book · Till · Cash · Shelf" height={height} width={Math.round(height * ratio)} />;
}

type TokenIcon = Exclude<keyof typeof tokens.icons, 'note' | 'logo-tally'>;
export type IconName = TokenIcon | keyof typeof extra;

const paths: Record<string, string> = { ...tokens.icons, ...extra };

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

/** Decorative only: every icon sits next to a text label, so it is hidden from assistive tech. */
export function Icon({ name, size = 20, strokeWidth = 2.2, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      <path d={paths[name]} />
    </svg>
  );
}
