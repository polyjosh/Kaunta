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

/** The Kaunta tally mark. Decorative: the bar name sits next to it. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="var(--k-ember)"
      strokeWidth={4.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10 10v28M18 10v28M26 10v28M34 10v28M5 33L41 15" />
    </svg>
  );
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
