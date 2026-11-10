/**
 * R-ORD-4: the last 4 characters of the M-Pesa code are optional; if given
 * they are exactly 4 of A–Z / 0–9, stored uppercase. Returns null for "not
 * entered" and throws for anything else, so a bad code is never saved.
 */
export function normaliseMpesaRef(input: string | null | undefined): string | null {
  const value = (input ?? '').trim().toUpperCase();
  if (value === '') return null;
  if (!/^[A-Z0-9]{4}$/.test(value)) {
    throw new RangeError('The M-Pesa code must be exactly 4 letters or digits');
  }
  return value;
}

/** R-ORD-5: split evenly, each share = ceil(due / n). */
export function evenShare(dueKes: number, people: number): number {
  if (!Number.isInteger(people) || people < 1) throw new RangeError('Split between at least 1 person');
  return Math.ceil(dueKes / people);
}

/** R-DAY-2: "#047" → 47, or null for a number not in that form. */
export function parseShortNo(shortNo: string): number | null {
  const match = /^#(\d+)$/.exec(shortNo);
  return match ? Number(match[1]) : null;
}

/** R-DAY-2: the next order number for a business day, given the numbers already used on it. */
export function nextShortNo(usedOnDay: readonly string[]): string {
  const highest = usedOnDay.reduce((max, shortNo) => Math.max(max, parseShortNo(shortNo) ?? 0), 0);
  return `#${String(highest + 1).padStart(3, '0')}`;
}
