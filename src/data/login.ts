import { activeLock, hasAccess, verifyPin, verifySecret, wrongPinOutcome } from '../domain/pin';
import type { Id, Instant, Person } from '../domain/types';
import type { KauntaDB } from './db';
import { recordEvent } from './outbox';

export type LoginResult =
  | { status: 'ok' }
  | { status: 'wrong'; tries_left: number }
  | { status: 'locked'; until: Instant };

/** Who appears on the counter's list: anyone with a PIN or password login whose access has not been removed. */
export function signsInAtCounter(person: Person): boolean {
  return (person.login === 'pin' || person.login === 'password') && hasAccess(person);
}

/**
 * R-PIN-1: checks a PIN (or an owner's password) against the hash on this
 * phone, so it works offline. Wrong tries and the lock they lead to are
 * recorded as events, so the lock reaches every device and the audit log. A
 * locked person is refused without the secret being checked at all. Someone
 * whose access was removed is refused too.
 */
export async function attemptLogin(
  db: KauntaDB,
  device_id: Id,
  person_id: Id,
  secret: string,
  now: () => Date = () => new Date(),
): Promise<LoginResult> {
  const [person, bar] = await Promise.all([db.people.get(person_id), db.bar.toCollection().first()]);
  if (!person || !bar) throw new Error(`Cannot log in: unknown person ${person_id}`);

  const locked = activeLock(person, now());
  if (locked) return { status: 'locked', until: locked };

  // Hashing runs outside any database transaction (it would end the transaction).
  const ok = hasAccess(person) && (person.login === 'password' ? await verifySecret(secret, person.pin_hash) : await verifyPin(secret, person.pin_hash));
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

/**
 * An owner or manager already signed in to admin on this browser goes to the
 * counter without signing in again: recorded as a login like any other.
 */
export async function loginSignedInAdmin(db: KauntaDB, device_id: Id, person_id: Id, now: () => Date = () => new Date()): Promise<boolean> {
  const person = await db.people.get(person_id);
  if (!person || !hasAccess(person) || (person.role !== 'owner' && person.role !== 'admin')) return false;
  await recordEvent(db, { person_id, device_id, now }, { type: 'logged_in', payload: { person_id } });
  return true;
}
