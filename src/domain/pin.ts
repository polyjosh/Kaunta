import type { Bar, Instant, Person } from './types';

const ITERATIONS = 100_000;
const SCHEME = 'pbkdf2-sha256';

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * R-PIN-2: only a salted hash is stored, and it is what paired phones verify
 * against offline. Format: `pbkdf2-sha256$iterations$salt$hash` (base64).
 */
export async function hashPin(pin: string, salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  if (!isValidPin(pin)) throw new RangeError('A PIN is exactly 4 digits');
  const hash = await derive(pin, salt, ITERATIONS);
  return [SCHEME, ITERATIONS, toB64(salt), toB64(hash)].join('$');
}

export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored || !isValidPin(pin)) return false;
  const [scheme, iterations, salt, expected] = stored.split('$');
  if (scheme !== SCHEME || !iterations || !salt || !expected) return false;
  const actual = toB64(await derive(pin, fromB64(salt), Number(iterations)));
  // Compare every character so timing does not reveal how much matched.
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  return diff === 0;
}

/** A fresh 4-digit PIN for someone at the counter (owners and managers set staff PINs). */
export function makePin(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0]! % 10_000).padStart(4, '0');
}

/** Whoever can still use the bar: not archived, not suspended. */
export function hasAccess(person: Pick<Person, 'archived_at' | 'suspended_at'>): boolean {
  return !person.archived_at && !person.suspended_at;
}

/** Owners sign in with a password; managers and counter staff with a 4-digit PIN. */
export const MIN_PASSWORD = 8;

/** Salted hash of any secret (an admin PIN, the platform password), in the same format as hashPin. */
export async function hashSecret(secret: string, salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  if (!secret) throw new RangeError('Nothing to hash');
  const hash = await derive(secret, salt, ITERATIONS);
  return [SCHEME, ITERATIONS, toB64(salt), toB64(hash)].join('$');
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || !secret) return false;
  const [scheme, iterations, salt, expected] = stored.split('$');
  if (scheme !== SCHEME || !iterations || !salt || !expected) return false;
  const actual = toB64(await derive(secret, fromB64(salt), Number(iterations)));
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  return diff === 0;
}

type LockView = Pick<Person, 'pin_locked_until' | 'failed_pin_attempts'>;
type LockRules = Pick<Bar, 'pin_attempts' | 'lockout_minutes'>;

/** The lock still in force at `now`, or null. An expired lock is no lock. */
export function activeLock(person: Pick<Person, 'pin_locked_until'>, now: Date): Instant | null {
  const until = person.pin_locked_until;
  return until && Date.parse(until) > now.getTime() ? until : null;
}

export interface WrongPinOutcome {
  failed_pin_attempts: number;
  pin_locked_until: Instant | null;
  tries_left: number;
}

/**
 * R-PIN-1: after `pin_attempts` consecutive wrong PINs the person is locked
 * for `lockout_minutes`. A lock that has run out starts the count afresh.
 */
export function wrongPinOutcome(person: LockView, rules: LockRules, now: Date): WrongPinOutcome {
  const lockExpired = person.pin_locked_until !== null && activeLock(person, now) === null;
  const failed_pin_attempts = (lockExpired ? 0 : person.failed_pin_attempts) + 1;
  const tries_left = Math.max(0, rules.pin_attempts - failed_pin_attempts);
  const pin_locked_until =
    tries_left === 0 ? new Date(now.getTime() + rules.lockout_minutes * 60_000).toISOString() : null;
  return { failed_pin_attempts, pin_locked_until, tries_left };
}

/** "4:52" until the lock ends; "0:00" once it has. */
export function lockCountdown(until: Instant, now: Date): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(until) - now.getTime()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** R-PIN-2: one-time reset codes are 6 digits, valid for a day. */
export const RESET_CODE_HOURS = 24;

export function isValidResetCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** A fresh 6-digit code from the platform's secure random source. */
export function makeResetCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(n).padStart(6, '0');
}

/** Same salted scheme as PINs, so a code can be checked on a counter offline. */
export async function hashResetCode(code: string, salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  if (!isValidResetCode(code)) throw new RangeError('A reset code is exactly 6 digits');
  const hash = await derive(code, salt, ITERATIONS);
  return [SCHEME, ITERATIONS, toB64(salt), toB64(hash)].join('$');
}

export async function verifyResetCode(code: string, stored: string | null | undefined, expiresAt: Instant | null | undefined, now: Date): Promise<boolean> {
  if (!stored || !expiresAt || Date.parse(expiresAt) <= now.getTime() || !isValidResetCode(code)) return false;
  const [scheme, iterations, salt, expected] = stored.split('$');
  if (scheme !== SCHEME || !iterations || !salt || !expected) return false;
  const actual = toB64(await derive(code, fromB64(salt), Number(iterations)));
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  return diff === 0;
}
