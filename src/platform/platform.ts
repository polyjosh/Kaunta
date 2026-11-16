import { useSyncExternalStore } from 'react';
import { canonicalBarCode, isChoosableBarCode, makeBarCode, normaliseBarCode, SAMPLE_BAR_CODE } from '../domain/barCode';
import { uuidv7 } from '../domain/ids';
import { hashSecret, isValidPin, makePin, MIN_PASSWORD, verifySecret } from '../domain/pin';
import type { Instant } from '../domain/types';

/**
 * The Kaunta platform, as this browser holds it while there is no server
 * (demo mode): the super admin's password, owner and manager accounts, every
 * bar with its counter code, and who may run which bar. Each bar's own data
 * (menu, staff, sales) lives in its IndexedDB store (src/admin/bars.ts).
 *
 * - The super admin (Kaunta staff) signs in at /super with a password, preset
 *   until they change it. They create owner accounts with a first bar, and
 *   see every bar.
 * - Owners sign in at /admin with a username and a password; managers with
 *   a username and a 4-digit PIN. Kaunta sets the first one; they can change
 *   it. Five wrong tries lock the account for 15 minutes. The same password
 *   or PIN lets them in at their bars' counters.
 * - An owner starts more bars, and may choose each bar's code (unique across
 *   all bars).
 */

export type MemberRole = 'owner' | 'admin';
export type SecretKind = 'password' | 'pin';

export interface Account {
  id: string;
  /** Lower case; letters, digits, dot, underscore, hyphen. Unique. */
  username: string;
  name: string;
  initial: string;
  colour: string;
  /** Their `people` row in each of their bars. */
  person_id: string;
  /** Owners have a password; managers a 4-digit PIN. */
  secret: SecretKind;
  /** Salted hash of the password or PIN; null while a demo account still has its preset. */
  pin_hash: string | null;
  /** Who chose the password or PIN in force: Kaunta (to be changed) or the person. */
  pin_set_by: 'kaunta' | 'self';
  failed_attempts: number;
  locked_until: Instant | null;
  created_at: Instant;
}

export interface PlatformBar {
  id: string;
  name: string;
  counter_code: string;
  owner_account_id: string;
  created_at: Instant;
  /** 'kaunta' for a first bar made by the super admin, else the owner's account id. */
  created_by: string;
}

export interface Membership {
  account_id: string;
  bar_id: string;
  role: MemberRole;
}

export interface Platform {
  version: 2;
  /** Null while the preset password is in force. */
  super_password_hash: string | null;
  super_password_changed_at: Instant | null;
  accounts: Account[];
  bars: PlatformBar[];
  members: Membership[];
}

// ------------------------------------------------------------- demo presets

/** The platform password until the super admin changes it (demo). */
export const PRESET_SUPER_PASSWORD = 'Kaunta@2026';
export const SAMPLE_BAR_ID = 'bar_baraka';
export const LOUNGE_BAR_ID = 'bar_demo_lounge';
export const LOUNGE_BAR_CODE = 'BRKA4NGE';

/** The sample owner (password) and manager (PIN), as Kaunta set them (demo). */
export const DEMO_OWNER = { id: 'acct_njeri', username: 'njeri', password: 'Baraka@2026' } as const;
export const DEMO_MANAGER = { id: 'acct_chebet', username: 'chebet', pin: '4826' } as const;
const PRESETS: Record<string, string> = { [DEMO_OWNER.id]: DEMO_OWNER.password, [DEMO_MANAGER.id]: DEMO_MANAGER.pin };

export const MAX_PIN_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
export { MIN_PASSWORD };

const EPOCH = '2026-11-10T00:00:00.000Z';

function defaults(): Platform {
  return {
    version: 2,
    super_password_hash: null,
    super_password_changed_at: null,
    accounts: [
      { id: DEMO_OWNER.id, username: DEMO_OWNER.username, name: 'Njeri', initial: 'N', colour: '#F2A0A0', person_id: 'p_njeri', secret: 'password', pin_hash: null, pin_set_by: 'kaunta', failed_attempts: 0, locked_until: null, created_at: EPOCH },
      { id: DEMO_MANAGER.id, username: DEMO_MANAGER.username, name: 'Chebet', initial: 'C', colour: '#C9B6F2', person_id: 'p_chebet', secret: 'pin', pin_hash: null, pin_set_by: 'kaunta', failed_attempts: 0, locked_until: null, created_at: EPOCH },
    ],
    bars: [
      { id: SAMPLE_BAR_ID, name: 'Baraka Pub', counter_code: SAMPLE_BAR_CODE, owner_account_id: DEMO_OWNER.id, created_at: EPOCH, created_by: 'kaunta' },
      { id: LOUNGE_BAR_ID, name: 'Baraka Lounge', counter_code: LOUNGE_BAR_CODE, owner_account_id: DEMO_OWNER.id, created_at: EPOCH, created_by: DEMO_OWNER.id },
    ],
    members: [
      { account_id: DEMO_OWNER.id, bar_id: SAMPLE_BAR_ID, role: 'owner' },
      { account_id: DEMO_OWNER.id, bar_id: LOUNGE_BAR_ID, role: 'owner' },
      { account_id: DEMO_MANAGER.id, bar_id: SAMPLE_BAR_ID, role: 'admin' },
    ],
  };
}

// ------------------------------------------------------------------ storage

const KEY = 'kaunta.platform';
const OLD_BARS_KEY = 'kaunta.demoBars';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storage = (): Store | null => (typeof localStorage === 'undefined' ? null : localStorage);

let cache: Platform | null = null;
const listeners = new Set<() => void>();

function read(): Platform {
  try {
    const raw = storage()?.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw) as StoredPlatform);
  } catch {
    // Unreadable: start again from the presets.
  }
  const fresh = defaults();
  // Bars started before accounts existed belong to the sample owner.
  try {
    const old = JSON.parse(storage()?.getItem(OLD_BARS_KEY) ?? 'null') as { id: string; name: string; counter_code?: string }[] | null;
    for (const b of old ?? []) {
      if (fresh.bars.some((x) => x.id === b.id)) continue;
      fresh.bars.push({ id: b.id, name: b.name, counter_code: b.counter_code ?? freshCode(fresh), owner_account_id: DEMO_OWNER.id, created_at: EPOCH, created_by: DEMO_OWNER.id });
      fresh.members.push({ account_id: DEMO_OWNER.id, bar_id: b.id, role: 'owner' });
    }
  } catch {
    // Nothing to bring over.
  }
  return fresh;
}

type StoredPlatform = Platform | (Omit<Platform, 'version' | 'accounts'> & { version: 1; accounts: Omit<Account, 'secret'>[] });

/**
 * Version 1 had a 6-digit PIN for everyone. Owners now have a password (their
 * old PIN works as it until changed); managers a 4-digit PIN (Kaunta sets a
 * new one for anyone who had chosen 6 digits).
 */
function migrate(stored: StoredPlatform): Platform {
  if (stored.version === 2) return stored;
  const owns = (id: string) => stored.members.some((m) => m.account_id === id && m.role === 'owner');
  return { ...stored, version: 2, accounts: stored.accounts.map((a) => ({ ...a, secret: owns(a.id) ? 'password' : 'pin' })) };
}

export function platform(): Platform {
  cache ??= read();
  return cache;
}

function save(next: Platform): Platform {
  cache = next;
  try {
    storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the change holds until the page is closed.
  }
  listeners.forEach((l) => l());
  return next;
}

function update(change: (p: Platform) => Platform): Platform {
  return save(change(platform()));
}

/** Read it from storage again (tests: as a new page load would). */
export function reloadPlatform(): void {
  cache = null;
  listeners.forEach((l) => l());
}

/** Forget everything (tests, and "start the demo again"). */
export function resetPlatform(): void {
  cache = null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  // Another tab changed it: read it again.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) {
      cache = null;
      listeners.forEach((l) => l());
    }
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The platform, re-rendering when it changes (here or in another tab). */
export function usePlatform(): Platform {
  return useSyncExternalStore(subscribe, platform, platform);
}

// --------------------------------------------------------------------- bars

export interface BarView {
  id: string;
  name: string;
  role: MemberRole;
  counter_code: string;
}

/** The bars an account may run, by name. */
export function barsFor(accountId: string, p: Platform = platform()): BarView[] {
  return p.members
    .filter((m) => m.account_id === accountId)
    .map((m) => {
      const bar = p.bars.find((b) => b.id === m.bar_id);
      return bar ? { id: bar.id, name: bar.name, role: m.role, counter_code: bar.counter_code } : null;
    })
    .filter((b): b is BarView => b !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function barByCode(code: string, p: Platform = platform()): PlatformBar | null {
  const wanted = canonicalBarCode(code);
  return wanted ? (p.bars.find((b) => canonicalBarCode(b.counter_code) === wanted) ?? null) : null;
}

/** Whether a code is already some bar's (look-alikes count as the same code). */
export function codeTaken(code: string, exceptBarId?: string, p: Platform = platform()): boolean {
  const bar = barByCode(code, p);
  return bar !== null && bar.id !== exceptBarId;
}

function freshCode(p: Platform): string {
  for (;;) {
    const code = makeBarCode();
    if (isChoosableBarCode(code) && !codeTaken(code, undefined, p)) return code;
  }
}

/** A code no bar has, to suggest. */
export function suggestCode(): string {
  return freshCode(platform());
}

export type CodeProblem = 'invalid' | 'taken';

export function checkCode(code: string, exceptBarId?: string): CodeProblem | null {
  if (!isChoosableBarCode(code)) return 'invalid';
  return codeTaken(code, exceptBarId) ? 'taken' : null;
}

/** An owner (or the super admin) sets a bar's code: their own, unique across all bars. */
export function setBarCode(barId: string, code: string): { code: string } | { error: CodeProblem } {
  const problem = checkCode(code, barId);
  if (problem) return { error: problem };
  const stored = normaliseBarCode(code);
  update((p) => ({ ...p, bars: p.bars.map((b) => (b.id === barId ? { ...b, counter_code: stored } : b)) }));
  return { code: stored };
}

/** An owner starts another bar. Its code is made unless they choose one. */
export function createBar(ownerAccountId: string, name: string, code?: string, by: string = ownerAccountId): { bar: PlatformBar } | { error: 'name' | CodeProblem } {
  const trimmed = name.trim();
  if (!trimmed) return { error: 'name' };
  const p = platform();
  if (code !== undefined && code.trim() !== '') {
    const problem = checkCode(code);
    if (problem) return { error: problem };
  }
  const bar: PlatformBar = {
    id: `bar_${uuidv7()}`,
    name: trimmed,
    counter_code: code?.trim() ? normaliseBarCode(code) : freshCode(p),
    owner_account_id: ownerAccountId,
    created_at: new Date().toISOString(),
    created_by: by,
  };
  update((q) => ({ ...q, bars: [...q.bars, bar], members: [...q.members, { account_id: ownerAccountId, bar_id: bar.id, role: 'owner' }] }));
  return { bar };
}

// ----------------------------------------------------------------- accounts

export function normaliseUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidUsername(input: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,29}$/.test(normaliseUsername(input));
}

export function accountById(id: string | null | undefined, p: Platform = platform()): Account | null {
  return (id && p.accounts.find((a) => a.id === id)) || null;
}

export function accountByUsername(username: string, p: Platform = platform()): Account | null {
  const u = normaliseUsername(username);
  return p.accounts.find((a) => a.username === u) ?? null;
}

function matches(account: Account, secret: string): Promise<boolean> | boolean {
  if (account.pin_hash) return verifySecret(secret, account.pin_hash);
  return PRESETS[account.id] !== undefined && secret === PRESETS[account.id];
}

/** Whether a password or PIN has the right shape for this kind of account. */
export function isValidSecret(kind: SecretKind, secret: string): boolean {
  return kind === 'pin' ? isValidPin(secret) : secret.length >= MIN_PASSWORD;
}

/**
 * The hash a bar's `people` row carries, so the counter can check this
 * person's password or PIN offline. A demo preset is hashed once and kept.
 */
export async function secretHash(accountId: string): Promise<string | null> {
  const account = accountById(accountId);
  if (!account) return null;
  if (account.pin_hash) return account.pin_hash;
  const preset = PRESETS[account.id];
  if (preset === undefined) return null;
  const pin_hash = await hashSecret(preset);
  const now = accountById(accountId);
  if (now?.pin_hash) return now.pin_hash;
  update((p) => ({ ...p, accounts: p.accounts.map((a) => (a.id === accountId ? { ...a, pin_hash } : a)) }));
  return pin_hash;
}

export type SignInResult =
  | { ok: true; account: Account }
  | { ok: false; reason: 'wrong'; triesLeft: number | null }
  | { ok: false; reason: 'locked'; until: Instant };

/** Username + password (owners) or PIN (managers). Wrong tries count toward a lock on that account; an unknown name says nothing more. */
export async function signIn(username: string, secret: string, now: Date = new Date()): Promise<SignInResult> {
  const account = accountByUsername(username);
  if (!account) return { ok: false, reason: 'wrong', triesLeft: null };
  if (account.locked_until && Date.parse(account.locked_until) > now.getTime()) return { ok: false, reason: 'locked', until: account.locked_until };
  if (await matches(account, secret)) {
    const fresh = { ...account, failed_attempts: 0, locked_until: null };
    update((p) => ({ ...p, accounts: p.accounts.map((a) => (a.id === account.id ? fresh : a)) }));
    return { ok: true, account: fresh };
  }
  const failed = account.failed_attempts + 1;
  const locked = failed >= MAX_PIN_ATTEMPTS ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
  update((p) => ({ ...p, accounts: p.accounts.map((a) => (a.id === account.id ? { ...a, failed_attempts: locked ? 0 : failed, locked_until: locked } : a)) }));
  return locked ? { ok: false, reason: 'locked', until: locked } : { ok: false, reason: 'wrong', triesLeft: MAX_PIN_ATTEMPTS - failed };
}

export type PinProblem = 'current' | 'invalid' | 'same';

/** The person changes their own password or PIN. */
export async function changeSecret(accountId: string, current: string, next: string): Promise<PinProblem | null> {
  const account = accountById(accountId);
  if (!account || !(await matches(account, current))) return 'current';
  if (!isValidSecret(account.secret, next)) return 'invalid';
  if (next === current) return 'same';
  const pin_hash = await hashSecret(next);
  update((p) => ({ ...p, accounts: p.accounts.map((a) => (a.id === accountId ? { ...a, pin_hash, pin_set_by: 'self', failed_attempts: 0, locked_until: null } : a)) }));
  return null;
}

/** The super admin sets a new password or PIN (forgotten, or locked out). It unlocks the account. */
export async function resetSecret(accountId: string, secret: string): Promise<'invalid' | null> {
  const account = accountById(accountId);
  if (!account || !isValidSecret(account.secret, secret)) return 'invalid';
  const pin_hash = await hashSecret(secret);
  update((p) => ({ ...p, accounts: p.accounts.map((a) => (a.id === accountId ? { ...a, pin_hash, pin_set_by: 'kaunta', failed_attempts: 0, locked_until: null } : a)) }));
  return null;
}

/** A 4-digit PIN to suggest when Kaunta sets one. */
export function suggestPin(): string {
  return makePin();
}

const PASSWORD_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A password to suggest when Kaunta sets one: easy to read out, "abcd-2345". */
export function suggestPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => PASSWORD_LETTERS[b % PASSWORD_LETTERS.length]!).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const COLOURS = ['#F2A0A0', '#9FD8C4', '#C9B6F2', '#F6C987', '#A9C8F0', '#F0B3D6'];

export interface NewPerson {
  name: string;
  username: string;
}

export type AccountProblem = 'name' | 'username' | 'usernameTaken' | 'pin' | 'password';

function checkPerson(input: NewPerson, kind: SecretKind, secret: string): AccountProblem | null {
  if (!input.name.trim()) return 'name';
  if (!isValidUsername(input.username)) return 'username';
  if (accountByUsername(input.username)) return 'usernameTaken';
  if (!isValidSecret(kind, secret)) return kind;
  return null;
}

async function newAccount(input: NewPerson, kind: SecretKind, secret: string): Promise<Account> {
  const name = input.name.trim();
  const p = platform();
  return {
    id: `acct_${uuidv7()}`,
    username: normaliseUsername(input.username),
    name,
    initial: name[0]!.toUpperCase(),
    colour: COLOURS[p.accounts.length % COLOURS.length]!,
    person_id: `p_${uuidv7()}`,
    secret: kind,
    pin_hash: await hashSecret(secret),
    pin_set_by: 'kaunta',
    failed_attempts: 0,
    locked_until: null,
    created_at: new Date().toISOString(),
  };
}

/**
 * The super admin creates a bar owner: their account (username, a password
 * Kaunta sets) and their first bar with its code (made, or chosen).
 */
export async function createOwner(input: NewPerson & { password: string; barName: string; barCode?: string }): Promise<{ account: Account; bar: PlatformBar } | { error: AccountProblem | 'barName' | CodeProblem }> {
  const problem = checkPerson(input, 'password', input.password);
  if (problem) return { error: problem };
  if (!input.barName.trim()) return { error: 'barName' };
  if (input.barCode?.trim()) {
    const codeProblem = checkCode(input.barCode);
    if (codeProblem) return { error: codeProblem };
  }
  const account = await newAccount(input, 'password', input.password);
  update((p) => ({ ...p, accounts: [...p.accounts, account] }));
  const made = createBar(account.id, input.barName, input.barCode, 'kaunta');
  if ('error' in made) throw new Error(`could not create the first bar: ${made.error}`);
  return { account, bar: made.bar };
}

/** A manager account for one bar (role admin there), with a 4-digit PIN Kaunta sets. */
export async function addManager(barId: string, input: NewPerson & { pin: string }): Promise<{ account: Account } | { error: AccountProblem }> {
  const problem = checkPerson(input, 'pin', input.pin);
  if (problem) return { error: problem };
  const account = await newAccount(input, 'pin', input.pin);
  update((p) => ({ ...p, accounts: [...p.accounts, account], members: [...p.members, { account_id: account.id, bar_id: barId, role: 'admin' }] }));
  return { account };
}

/** Who may run a bar, owner first. */
export function membersOf(barId: string, p: Platform = platform()): { account: Account; role: MemberRole }[] {
  return p.members
    .filter((m) => m.bar_id === barId)
    .map((m) => ({ account: accountById(m.account_id, p)!, role: m.role }))
    .filter((m) => m.account)
    .sort((a, b) => (a.role === b.role ? a.account.name.localeCompare(b.account.name) : a.role === 'owner' ? -1 : 1));
}

// --------------------------------------------------------------- super admin

export async function verifySuperPassword(password: string): Promise<boolean> {
  const p = platform();
  return p.super_password_hash ? verifySecret(password, p.super_password_hash) : password === PRESET_SUPER_PASSWORD;
}

export type PasswordProblem = 'current' | 'short' | 'same';

export async function changeSuperPassword(current: string, next: string): Promise<PasswordProblem | null> {
  if (!(await verifySuperPassword(current))) return 'current';
  if (next.length < MIN_PASSWORD) return 'short';
  if (next === current) return 'same';
  const hash = await hashSecret(next);
  update((p) => ({ ...p, super_password_hash: hash, super_password_changed_at: new Date().toISOString() }));
  return null;
}

// ----------------------------------------------------------------- sessions

const OWNER_SESSION = 'kaunta.adminSession';
const SUPER_SESSION = 'kaunta.superSession';

function readSession(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string | null): void {
  try {
    if (value) storage()?.setItem(key, value);
    else storage()?.removeItem(key);
  } catch {
    // Not remembered: sign in again next time.
  }
}

/** The owner or manager signed in on this browser (demo). */
export function ownerSession(): string | null {
  const id = readSession(OWNER_SESSION);
  return accountById(id) ? id : null;
}

export function setOwnerSession(accountId: string | null): void {
  writeSession(OWNER_SESSION, accountId);
}

export function superSession(): boolean {
  return readSession(SUPER_SESSION) === 'yes';
}

export function setSuperSession(on: boolean): void {
  writeSession(SUPER_SESSION, on ? 'yes' : null);
}
