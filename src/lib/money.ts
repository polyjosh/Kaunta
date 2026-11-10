/**
 * Money is integer KES everywhere: no decimals, no floats.
 *
 * A negative amount is never formatted. Shortfalls are written as words
 * ("Short KES 300"), so callers pass the magnitude and pick the label.
 */
function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount)) {
    throw new TypeError(`Money must be an integer number of KES, got ${amount}`);
  }
  if (amount < 0) {
    throw new RangeError(
      `Money is never shown with a minus sign (got ${amount}). Format the magnitude and say "Short" in words.`,
    );
  }
}

/** `1250 → "1,250"`. For amounts that sit next to an explicit "KES" elsewhere. */
export function formatAmount(amount: number): string {
  assertAmount(amount);
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `1250 → "KES 1,250"`. */
export function formatKES(amount: number): string {
  return `KES ${formatAmount(amount)}`;
}
