import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeLock, hashPin, isValidPin, lockCountdown, verifyPin, wrongPinOutcome } from '../domain/pin';
import { KauntaDB } from './db';
import { attemptLogin } from './login';
import { pendingEvents } from './outbox';
import { seedDatabase } from './seedDb';

describe('PIN hashing (R-PIN-2)', () => {
  it('stores a salted hash, never the PIN', async () => {
    const a = await hashPin('2580');
    const b = await hashPin('2580');
    expect(a).not.toContain('2580');
    expect(a).not.toBe(b); // different salt each time
    expect(await verifyPin('2580', a)).toBe(true);
    expect(await verifyPin('2580', b)).toBe(true);
  });

  it('rejects the wrong PIN, a missing hash and malformed input', async () => {
    const hash = await hashPin('2580');
    expect(await verifyPin('2581', hash)).toBe(false);
    expect(await verifyPin('2580', null)).toBe(false);
    expect(await verifyPin('2580', 'not-a-hash')).toBe(false);
    expect(await verifyPin('258', hash)).toBe(false);
  });

  it('accepts exactly 4 digits', async () => {
    expect(isValidPin('0000')).toBe(true);
    for (const bad of ['123', '12345', '12a4', '']) expect(isValidPin(bad)).toBe(false);
    await expect(hashPin('12345')).rejects.toThrow(RangeError);
  });
});

describe('lockout rules (R-PIN-1)', () => {
  const rules = { pin_attempts: 5, lockout_minutes: 5 };
  const now = new Date('2026-11-10T19:00:00.000Z');
  const person = (failed: number, until: string | null = null) => ({ failed_pin_attempts: failed, pin_locked_until: until });

  it('counts down the tries, then locks on the 5th for 5 minutes', () => {
    expect(wrongPinOutcome(person(0), rules, now)).toEqual({ failed_pin_attempts: 1, pin_locked_until: null, tries_left: 4 });
    expect(wrongPinOutcome(person(3), rules, now)).toEqual({ failed_pin_attempts: 4, pin_locked_until: null, tries_left: 1 });
    expect(wrongPinOutcome(person(4), rules, now)).toEqual({
      failed_pin_attempts: 5,
      pin_locked_until: '2026-11-10T19:05:00.000Z',
      tries_left: 0,
    });
  });

  it('starts the count afresh once a lock has run out', () => {
    const expired = person(5, '2026-11-10T18:59:00.000Z');
    expect(activeLock(expired, now)).toBeNull();
    expect(wrongPinOutcome(expired, rules, now).tries_left).toBe(4);
  });

  it('reports a lock that is still running, and its countdown', () => {
    const until = '2026-11-10T19:04:52.000Z';
    expect(activeLock(person(5, until), now)).toBe(until);
    expect(lockCountdown(until, now)).toBe('4:52');
    expect(lockCountdown(until, new Date('2026-11-10T19:04:51.500Z'))).toBe('0:01');
    expect(lockCountdown(until, new Date('2026-11-10T19:10:00.000Z'))).toBe('0:00');
  });
});

describe('attemptLogin', () => {
  let db: KauntaDB;
  let n = 0;
  let clock = new Date('2026-11-10T19:00:00.000Z');
  const now = () => clock;
  const login = (person: string, pin: string) => attemptLogin(db, 'd_counter1', person, pin, now);

  beforeEach(async () => {
    clock = new Date('2026-11-10T19:00:00.000Z');
    db = new KauntaDB(`kaunta-login-${++n}`);
    await seedDatabase(db, { now: clock });
  });
  afterEach(() => db.delete());

  it('seeds a hash for the demo PIN and no plain PIN anywhere', async () => {
    const wanjiku = await db.people.get('p_wanjiku');
    expect(wanjiku?.pin_hash).toMatch(/^pbkdf2-sha256\$/);
    expect(JSON.stringify(await db.people.toArray())).not.toContain('2580');
  });

  it('lets the right PIN in and records the login', async () => {
    expect(await login('p_wanjiku', '2580')).toEqual({ status: 'ok' });
    expect((await pendingEvents(db)).map((e) => e.type)).toEqual(['logged_in']);
  });

  it('counts wrong tries down, then locks on the 5th and records each one', async () => {
    for (const left of [4, 3, 2, 1]) expect(await login('p_wanjiku', '0000')).toEqual({ status: 'wrong', tries_left: left });
    expect(await login('p_wanjiku', '0000')).toEqual({ status: 'locked', until: '2026-11-10T19:05:00.000Z' });

    const events = await pendingEvents(db);
    expect(events.map((e) => e.type)).toEqual(Array(5).fill('pin_failed'));
    expect(events.at(-1)).toMatchObject({
      recorded_by: 'p_wanjiku',
      device_id: 'd_counter1',
      payload: { failed_pin_attempts: 5, pin_locked_until: '2026-11-10T19:05:00.000Z' },
    });
  });

  it('refuses even the right PIN while locked, and accepts it once the lock runs out', async () => {
    for (let i = 0; i < 5; i++) await login('p_wanjiku', '0000');
    expect(await login('p_wanjiku', '2580')).toMatchObject({ status: 'locked' });

    clock = new Date('2026-11-10T19:05:01.000Z');
    expect(await login('p_wanjiku', '2580')).toEqual({ status: 'ok' });
    expect(await db.people.get('p_wanjiku')).toMatchObject({ failed_pin_attempts: 0, pin_locked_until: null });
  });

  it('a correct PIN resets the wrong-try count', async () => {
    await login('p_wanjiku', '0000');
    await login('p_wanjiku', '0000');
    await login('p_wanjiku', '2580');
    expect(await login('p_wanjiku', '0000')).toEqual({ status: 'wrong', tries_left: 4 });
  });

  it('shows the seeded lock on Otieno as 4:52 from the moment of seeding', async () => {
    const result = await login('p_otieno', '2580');
    expect(result.status).toBe('locked');
    if (result.status === 'locked') expect(lockCountdown(result.until, clock)).toBe('4:52');
  });

  it('never lets in someone who has no PIN set', async () => {
    expect(await login('p_akinyi', '2580')).toEqual({ status: 'wrong', tries_left: 4 });
  });
});
