import type { ApprovalKind, Id, OrderLine, VoidReason } from './types';

export const VOID_REASONS: readonly VoidReason[] = ['mistake', 'changed', 'size', 'spilled', 'other'];

/** Reasons a person may void with by themselves, inside the window (R-VOID-1). */
const SELF_REASONS: readonly VoidReason[] = ['mistake', 'changed', 'size'];

type VoidLine = Pick<OrderLine, 'created_at' | 'recorded_by'>;

/**
 * Milliseconds left in which `personId` may void these lines without an
 * admin: they recorded every one of them, and the oldest is younger than the
 * window. Zero when the window is shut or was never open.
 */
export function selfVoidMsLeft(lines: readonly VoidLine[], personId: Id, now: Date, windowMinutes: number): number {
  if (lines.length === 0 || lines.some((line) => line.recorded_by !== personId)) return 0;
  const oldest = Math.min(...lines.map((line) => Date.parse(line.created_at)));
  const windowMs = windowMinutes * 60_000;
  // Never more than the window itself: a line stamped in the future (a device
  // clock that was wrong) must not buy extra time.
  return Math.min(windowMs, Math.max(0, oldest + windowMs - now.getTime()));
}

export interface VoidRoute {
  /** `self` voids at once; `approval` leaves the lines on the order until an admin decides. */
  route: 'self' | 'approval';
  kind: Extract<ApprovalKind, 'void' | 'write_off'>;
}

/**
 * R-VOID-1…3. Self-void needs an allowed reason inside the window on lines
 * you recorded. "Something else" always goes to an admin. "Spilled or
 * broken" is a write-off (stock is not returned) and always needs approval.
 * `moneyAtStake` is set when the void would leave the order having been paid
 * more than it is worth; that is an admin's call too.
 */
export function voidRoute(
  reason: VoidReason,
  msLeft: number,
  moneyAtStake = false,
): VoidRoute {
  const kind = reason === 'spilled' ? 'write_off' : 'void';
  const self = SELF_REASONS.includes(reason) && msLeft > 0 && !moneyAtStake;
  return { route: self ? 'self' : 'approval', kind };
}

/** "3:12" for the live window countdown and "recorded 1:48 ago". */
export function clockMinutes(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
