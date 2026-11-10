import { activeLock, hashPin, isValidPin, verifyPin, verifyResetCode, wrongPinOutcome } from '../domain/pin';
import type { Id, Instant } from '../domain/types';
import type { KauntaDB } from './db';
import { recordEvent } from './outbox';

export type LoginResult =
  | { status: 'ok' }
  | { status: 'wrong'; tries_left: number }
  | { status: 'locked'; until: Instant };

/**
 * R-PIN-1: checks a PIN against the hash on this phone (works offline).
 * Wrong tries and the lock they lead to are recorded as events, so the lock
 * reaches every device and the audit log. A locked person is refused without
 * the PIN being checked at all.
 */
export async function attemptLogin(
  db: KauntaDB,
  device_id: Id,
  person_id: Id,
  pin: string,
  now: () => Date = () => new Date(),
): Promise<LoginResult> {
  const [person, bar] = await Promise.all([db.people.get(person_id), db.bar.toCollection().first()]);
  if (!person || !bar) throw new Error(`Cannot log in: unknown person ${person_id}`);

  const locked = activeLock(person, now());
  if (locked) return { status: 'locked', until: locked };

  // Hashing runs outside any database transaction (it would end the transaction).
  const ok = await verifyPin(pin, person.pin_hash);
  const ctx = { person_id, device_id, now };

  if (ok) {
    await recordEvent(db, ctx, { type: 'logged_in', payload: { person_id } });
    return { status: 'ok' };
  }

  const fresh = (await db.people.get(person_id)) ?? person;
  const outcome = wrongPinOutcome(fresh, bar, now());
  await recordEvent(db, ctx, {
    type: 'pin_failed',
    payload: {
      person_id,
      failed_pin_attempts: outcome.failed_pin_attempts,
      pin_locked_until: outcome.pin_locked_until,
    },
  });
  return outcome.pin_locked_until
    ? { status: 'locked', until: outcome.pin_locked_until }
    : { status: 'wrong', tries_left: outcome.tries_left };
}

/** A reset is waiting for this person: an admin made a one-time code that has not run out (R-PIN-2). */
export function hasPinReset(person: { pin_reset_hash?: string | null; pin_reset_expires_at?: Instant | null }, now: Date): boolean {
  return !!person.pin_reset_hash && !!person.pin_reset_expires_at && Date.parse(person.pin_reset_expires_at) > now.getTime();
}

/**
 * R-PIN-2, step 1: the one-time code from the admin, checked against its hash
 * on this phone. A wrong code counts as a wrong PIN, so guessing locks the
 * person out exactly as wrong PINs do (R-PIN-1).
 */
export async function checkResetCode(
  db: KauntaDB,
  device_id: Id,
  person_id: Id,
  code: string,
  now: () => Date = () => new Date(),
): Promise<LoginResult> {
  const [person, bar] = await Promise.all([db.people.get(person_id), db.bar.toCollection().first()]);
  if (!person || !bar) throw new Error(`Unknown person ${person_id}`);
  const locked = activeLock(person, now());
  if (locked) return { status: 'locked', until: locked };
  if (await verifyResetCode(code, person.pin_reset_hash, person.pin_reset_expires_at, now())) return { status: 'ok' };
  const outcome = wrongPinOutcome(person, bar, now());
  await recordEvent(db, { person_id, device_id, now }, {
    type: 'pin_failed',
    payload: { person_id, failed_pin_attempts: outcome.failed_pin_attempts, pin_locked_until: outcome.pin_locked_until },
  });
  return outcome.pin_locked_until ? { status: 'locked', until: outcome.pin_locked_until } : { status: 'wrong', tries_left: outcome.tries_left };
}

/** R-PIN-2, step 2: the new PIN is hashed here and only the hash is recorded; then the person is logged in. */
export async function setNewPin(db: KauntaDB, device_id: Id, person_id: Id, pin: string, now: () => Date = () => new Date()): Promise<void> {
  if (!isValidPin(pin)) throw new RangeError('A PIN is exactly 4 digits');
  const pin_hash = await hashPin(pin);
  const ctx = { person_id, device_id, now };
  await recordEvent(db, ctx, { type: 'pin_set', payload: { person_id, pin_hash } });
  await recordEvent(db, ctx, { type: 'logged_in', payload: { person_id } });
}
