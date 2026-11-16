/**
 * The counter code of a bar: what a counter phone types once to join the bar
 * (staff then log in with their PIN). Kaunta makes one when a bar is created
 * (8 characters from an alphabet without look-alikes); the owner may choose
 * their own instead: 6 to 12 letters or digits, unique across all bars.
 *
 * Codes are compared in canonical form: upper case, letters and digits only,
 * and look-alikes folded (O → 0, I and L → 1), so "BARAKA01" and "baraka-o1"
 * are the same code and cannot belong to two bars.
 */
export const BAR_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const BAR_CODE_LENGTH = 8;
export const BAR_CODE_MIN = 6;
export const BAR_CODE_MAX = 12;

/** The sample bar (Baraka Pub), the same in the demo and in supabase/seed.sql. */
export const SAMPLE_BAR_CODE = 'BRKAPUB2';

/** "brka-pub2", "BRKA PUB2" → "BRKAPUB2": what is stored and shown. */
export function normaliseBarCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** What two codes are compared by: look-alikes folded. */
export function canonicalBarCode(input: string): string {
  return normaliseBarCode(input).replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Shown in groups of four: "BRKA-PUB2", "BARA-KA01-X". */
export function formatBarCode(code: string): string {
  return (normaliseBarCode(code).match(/.{1,4}/g) ?? []).join('-');
}

/** Long enough and short enough to be a bar code (whether one exists is another matter). */
export function isBarCode(input: string): boolean {
  const c = normaliseBarCode(input);
  return c.length >= BAR_CODE_MIN && c.length <= BAR_CODE_MAX;
}

/** A one-time pairing code from an admin (6 digits), rather than a bar code. */
export function isPairingCode(input: string): boolean {
  return /^\d{6}$/.test(input.replace(/\s/g, ''));
}

/** A new random code (the demo makes its own; a server makes them in SQL). */
export function makeBarCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...random(BAR_CODE_LENGTH)].map((b) => BAR_CODE_ALPHABET[b % BAR_CODE_ALPHABET.length]).join('');
}

/**
 * A code an owner (or Kaunta) may choose: 6–12 letters or digits with at
 * least one letter, so it can never be mistaken for a 6-digit pairing code.
 */
export function isChoosableBarCode(input: string): boolean {
  return isBarCode(input) && /[A-Z]/.test(normaliseBarCode(input));
}
