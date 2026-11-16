import { beforeEach, describe, expect, it } from 'vitest';
import {
  accountByUsername,
  addManager,
  barByCode,
  barsFor,
  changeSecret,
  changeSuperPassword,
  checkCode,
  createBar,
  createOwner,
  DEMO_MANAGER,
  DEMO_OWNER,
  LOCK_MINUTES,
  platform,
  reloadPlatform,
  PRESET_SUPER_PASSWORD,
  resetPlatform,
  resetSecret,
  secretHash,
  setBarCode,
  signIn,
  suggestPassword,
  suggestPin,
  verifySuperPassword,
} from './platform';

beforeEach(() => {
  localStorage.clear();
  resetPlatform();
});

describe('the platform to start with (demo)', () => {
  it('has the sample owner with two bars, a manager of the pub, and the preset password', async () => {
    expect(barsFor(DEMO_OWNER.id).map((b) => [b.name, b.role, b.counter_code])).toEqual([
      ['Baraka Lounge', 'owner', 'BRKA4NGE'],
      ['Baraka Pub', 'owner', 'BRKAPUB2'],
    ]);
    expect(barsFor(DEMO_MANAGER.id).map((b) => [b.name, b.role])).toEqual([['Baraka Pub', 'admin']]);
    expect(await verifySuperPassword(PRESET_SUPER_PASSWORD)).toBe(true);
    expect(await verifySuperPassword('guess')).toBe(false);
  });
});

describe('owner and manager sign-in: username + password (owners) or 4-digit PIN (managers)', () => {
  it('lets the right password or PIN in, whatever the username’s case', async () => {
    expect(await signIn(' Njeri ', DEMO_OWNER.password)).toMatchObject({ ok: true, account: { id: DEMO_OWNER.id, secret: 'password' } });
    expect(await signIn('chebet', DEMO_MANAGER.pin)).toMatchObject({ ok: true, account: { id: DEMO_MANAGER.id, secret: 'pin' } });
  });

  it('counts wrong tries, locks for 15 minutes after the 5th, and says nothing about unknown names', async () => {
    const now = new Date('2026-11-16T10:00:00.000Z');
    expect(await signIn('nobody', '111111', now)).toEqual({ ok: false, reason: 'wrong', triesLeft: null });
    for (let left = 4; left >= 1; left--) expect(await signIn('njeri', 'not-it', now)).toEqual({ ok: false, reason: 'wrong', triesLeft: left });
    const locked = await signIn('njeri', 'not-it', now);
    expect(locked).toMatchObject({ ok: false, reason: 'locked' });
    // Locked: even the right password waits.
    expect(await signIn('njeri', DEMO_OWNER.password, new Date(now.getTime() + 60_000))).toMatchObject({ reason: 'locked' });
    expect((await signIn('njeri', DEMO_OWNER.password, new Date(now.getTime() + LOCK_MINUTES * 60_000 + 1)))).toMatchObject({ ok: true });
  });

  it('the owner changes the password Kaunta set; the old one stops working', async () => {
    expect(accountByUsername('njeri')!.pin_set_by).toBe('kaunta');
    expect(await changeSecret(DEMO_OWNER.id, 'wrong-one', 'my-own-pass')).toBe('current');
    expect(await changeSecret(DEMO_OWNER.id, DEMO_OWNER.password, 'short')).toBe('invalid');
    expect(await changeSecret(DEMO_OWNER.id, DEMO_OWNER.password, DEMO_OWNER.password)).toBe('same');
    expect(await changeSecret(DEMO_OWNER.id, DEMO_OWNER.password, 'my-own-pass')).toBeNull();
    expect(accountByUsername('njeri')!.pin_set_by).toBe('self');
    expect(accountByUsername('njeri')!.pin_hash).not.toContain('my-own-pass');
    expect(await signIn('njeri', DEMO_OWNER.password)).toMatchObject({ ok: false });
    expect(await signIn('njeri', 'my-own-pass')).toMatchObject({ ok: true });
  });

  it('a manager’s PIN is 4 digits', async () => {
    expect(await changeSecret(DEMO_MANAGER.id, DEMO_MANAGER.pin, '123456')).toBe('invalid');
    expect(await changeSecret(DEMO_MANAGER.id, DEMO_MANAGER.pin, '1357')).toBeNull();
    expect(await signIn('chebet', '1357')).toMatchObject({ ok: true });
  });

  it('the super admin can set a new PIN or password, which also unlocks', async () => {
    const now = new Date();
    for (let i = 0; i < 5; i++) await signIn('chebet', '0000', now);
    expect(await signIn('chebet', DEMO_MANAGER.pin, now)).toMatchObject({ reason: 'locked' });
    expect(await resetSecret(DEMO_MANAGER.id, '12')).toBe('invalid');
    expect(await resetSecret(DEMO_MANAGER.id, '4455')).toBeNull();
    expect(await signIn('chebet', '4455', now)).toMatchObject({ ok: true });
    expect(accountByUsername('chebet')!.pin_set_by).toBe('kaunta');
    expect(await resetSecret(DEMO_OWNER.id, '4455')).toBe('invalid');
    expect(await resetSecret(DEMO_OWNER.id, 'kaunta-set-1')).toBeNull();
    expect(await signIn('njeri', 'kaunta-set-1', now)).toMatchObject({ ok: true });
  });

  it('a demo preset is hashed once, for the counter to check offline', async () => {
    const hash = await secretHash(DEMO_MANAGER.id);
    expect(hash).toMatch(/^pbkdf2-sha256\$/);
    expect(await secretHash(DEMO_MANAGER.id)).toBe(hash);
    expect(await signIn('chebet', DEMO_MANAGER.pin)).toMatchObject({ ok: true });
  });

  it('accounts from before (everyone a 6-digit PIN) become owners with a password, managers with a PIN', () => {
    const v1 = { ...platform(), version: 1, accounts: platform().accounts.map(({ secret: _s, ...a }) => a) };
    localStorage.setItem('kaunta.platform', JSON.stringify(v1));
    reloadPlatform();
    expect(platform().accounts.map((a) => [a.username, a.secret])).toEqual([['njeri', 'password'], ['chebet', 'pin']]);
  });
});

describe('the super admin creates owners and their first bar', () => {
  it('an owner with a username, a password Kaunta sets, and a first bar with the code chosen', async () => {
    const made = await createOwner({ name: 'Amina', username: 'Amina.K', password: 'amina-2026', barName: 'Kilimani Lounge', barCode: 'kili-mani' });
    expect('error' in made).toBe(false);
    if ('error' in made) return;
    expect(made.account).toMatchObject({ username: 'amina.k', pin_set_by: 'kaunta', secret: 'password' });
    expect(made.bar).toMatchObject({ name: 'Kilimani Lounge', counter_code: 'KILIMANI', created_by: 'kaunta', owner_account_id: made.account.id });
    expect(barsFor(made.account.id).map((b) => b.name)).toEqual(['Kilimani Lounge']);
    expect(await signIn('amina.k', 'amina-2026')).toMatchObject({ ok: true });
    // She does not see Njeri's bars, nor Njeri hers.
    expect(barsFor(DEMO_OWNER.id).map((b) => b.name)).not.toContain('Kilimani Lounge');
  });

  it('a bar code is made when none is chosen', async () => {
    const made = await createOwner({ name: 'Otis', username: 'otis', password: suggestPassword(), barName: 'Otis Bar' });
    if ('error' in made) throw new Error(made.error);
    expect(made.bar.counter_code).toMatch(/^[23456789A-HJKMNP-Z]{8}$/);
  });

  it('refuses what would be ambiguous or clash', async () => {
    const base = { name: 'Amina', username: 'amina', password: 'amina-2026', barName: 'Kilimani' };
    expect(await createOwner({ ...base, name: ' ' })).toEqual({ error: 'name' });
    expect(await createOwner({ ...base, username: 'a' })).toEqual({ error: 'username' });
    expect(await createOwner({ ...base, username: 'njeri' })).toEqual({ error: 'usernameTaken' });
    expect(await createOwner({ ...base, password: 'short' })).toEqual({ error: 'password' });
    expect(await createOwner({ ...base, barName: '' })).toEqual({ error: 'barName' });
    expect(await createOwner({ ...base, barCode: 'BRKA-PUB2' })).toEqual({ error: 'taken' });
    expect(await createOwner({ ...base, barCode: '123456' })).toEqual({ error: 'invalid' });
    expect(platform().accounts.some((a) => a.username === 'amina')).toBe(false);
  });

  it('a manager account for one bar, with a 4-digit PIN', async () => {
    expect(await addManager('bar_baraka', { name: 'Wairimu', username: 'wairimu', pin: '556677' })).toEqual({ error: 'pin' });
    const made = await addManager('bar_baraka', { name: 'Wairimu', username: 'wairimu', pin: '5566' });
    if ('error' in made) throw new Error(made.error);
    expect(made.account.secret).toBe('pin');
    expect(barsFor(made.account.id).map((b) => [b.name, b.role])).toEqual([['Baraka Pub', 'admin']]);
  });

  it('suggests 4-digit PINs and readable passwords', () => {
    expect(suggestPin()).toMatch(/^\d{4}$/);
    expect(suggestPassword()).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
  });
});

describe('bar codes are unique across all bars', () => {
  it('an owner chooses their code; another bar’s (or its look-alike) is refused', () => {
    const made = createBar(DEMO_OWNER.id, 'Baraka Garden');
    if ('error' in made) throw new Error(made.error);
    expect(setBarCode(made.bar.id, 'garden-01')).toEqual({ code: 'GARDEN01' });
    expect(checkCode('GARDENO1')).toBe('taken'); // O for 0
    expect(checkCode('GARDENOI')).toBe('taken'); // and I for 1
    expect(setBarCode('bar_baraka', 'gardenol')).toEqual({ error: 'taken' });
    expect(checkCode('GARDEN01', made.bar.id)).toBeNull(); // its own
    expect(setBarCode('bar_baraka', 'AB1')).toEqual({ error: 'invalid' });
    expect(barByCode('garden o1')?.id).toBe(made.bar.id);
  });

  it('a new bar can be started with a chosen code, if it is free', () => {
    expect(createBar(DEMO_OWNER.id, 'Clash', 'BRKAPUB2')).toEqual({ error: 'taken' });
    const ok = createBar(DEMO_OWNER.id, 'Free', 'FREE-BAR');
    expect('bar' in ok && ok.bar.counter_code).toBe('FREEBAR');
  });
});

describe('the platform password', () => {
  it('is preset until changed; then only the new one works', async () => {
    expect(await changeSuperPassword('wrong', 'new-password-1')).toBe('current');
    expect(await changeSuperPassword(PRESET_SUPER_PASSWORD, 'short')).toBe('short');
    expect(await changeSuperPassword(PRESET_SUPER_PASSWORD, 'new-password-1')).toBeNull();
    expect(await verifySuperPassword(PRESET_SUPER_PASSWORD)).toBe(false);
    expect(await verifySuperPassword('new-password-1')).toBe(true);
    expect(platform().super_password_hash).not.toContain('new-password-1');
  });
});
