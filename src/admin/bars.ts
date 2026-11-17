import { db as sampleCounterDb, KauntaDB } from '../data/db';
import { recordAdminEvent } from '../data/adminEvents';
import { defaultCategories } from '../domain/presets';
import { loadSeed } from '../domain/seed';
import type { Person } from '../domain/types';
import {
  barByCode,
  createBar,
  DEMO_OWNER,
  LOUNGE_BAR_CODE,
  membersOf,
  platform,
  SAMPLE_BAR_ID,
  secretHash,
  setBarCode,
  setOwnerSession,
  suggestCode,
} from '../platform/platform';
import type { Account, CodeProblem, MemberRole, PlatformBar } from '../platform/platform';

/** A bar the signed-in owner or admin can open (admin_bars()). */
export interface BarSummary {
  id: string;
  name: string;
  role: 'owner' | 'admin';
  person_id?: string;
  /** What a counter phone types to join this bar. */
  counter_code?: string;
}

/** Where the list of bars comes from: the server, or the demo's own list. */
export interface BarDirectory {
  list(): Promise<BarSummary[]>;
  /** Starts another bar, owned by the signed-in owner. */
  create(name: string): Promise<BarSummary>;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storage = (): Store | null => (typeof localStorage === 'undefined' ? null : localStorage);

function read<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // A preference that is not remembered just means choosing again.
  }
}

const LAST_BAR = 'kaunta.adminBar';
const KNOWN_BARS = 'kaunta.adminBars';

/** The bar opened last on this browser, if it is still one of `bars`. */
export function rememberedBar(bars: readonly BarSummary[], key = LAST_BAR): string | null {
  const id = read<string>(key);
  return id && bars.some((b) => b.id === id) ? id : null;
}

export function rememberBar(id: string | null, key = LAST_BAR): void {
  write(key, id);
}

/** The bars last fetched, so admin still opens with a poor connection. */
export function cachedBars(): BarSummary[] | null {
  return read<BarSummary[]>(KNOWN_BARS);
}

export function cacheBars(bars: BarSummary[] | null): void {
  write(KNOWN_BARS, bars);
}

/** Each bar has its own admin store on this browser, so switching never mixes two bars' rows. */
export function liveStoreName(barId: string): string {
  return `kaunta-admin-${barId}`;
}

// ------------------------------------------------------------------ demo
//
// Without a server, everything lives in this browser. Accounts, bars and
// codes are in the platform directory (src/platform/platform.ts); each bar's
// data is in its own IndexedDB store. A bar created here is fully live in
// this browser: admin and the counter share its store, so staff added in
// admin can log in at the counter, and what the counter sells shows in admin
// at once (src/data/demoServer.ts). The sample bar is the exception: the
// designs show it at two moments (the counter at 22:20, admin at 02:14 on the
// sample night), so it keeps one store for each.

export const DEMO_SAMPLE_BAR = SAMPLE_BAR_ID;
const DEMO_LAST = 'kaunta.adminDemoBar';
const COUNTER_BAR = 'kaunta.counterBar';
export { LOUNGE_BAR_CODE as DEMO_LOUNGE_CODE };

const summary = (b: PlatformBar): BarSummary => ({ id: b.id, name: b.name, role: 'owner', counter_code: b.counter_code });

/** Every bar on the platform (the counter looks codes up among all of them). */
export function demoBars(): BarSummary[] {
  return platform().bars.map(summary);
}

/** Starting a bar for an owner (the sample owner unless said otherwise). */
export const demoDirectory = {
  list: async () => demoBars(),
  create: async (name: string, ownerAccountId: string = DEMO_OWNER.id, code?: string): Promise<BarSummary> => {
    const made = createBar(ownerAccountId, name, code);
    if ('error' in made) throw new Error(made.error);
    return summary(made.bar);
  },
};

/** The bar a counter code belongs to, if any. */
export function demoBarByCode(code: string): BarSummary | null {
  const bar = barByCode(code);
  return bar ? summary(bar) : null;
}

/** A bar's code: one the owner chose (checked unique), or a fresh one. Updates the bar's store too. */
export async function newDemoBarCode(barId: string, code?: string): Promise<{ code: string } | { error: CodeProblem }> {
  const result = setBarCode(barId, code ?? suggestCode());
  if ('code' in result && barId !== DEMO_SAMPLE_BAR) await demoStore(barId).bar.update(barId, { counter_code: result.code });
  return result;
}

/**
 * Demo: an owner or manager logged in at the counter opens admin on the same
 * bar without signing in again. False if that person has no account there.
 */
export function signInToAdminAs(personId: string, barId: string): boolean {
  const p = platform();
  const account = p.accounts.find((a) => a.person_id === personId && p.members.some((m) => m.account_id === a.id && m.bar_id === barId));
  if (!account) return false;
  setOwnerSession(account.id);
  rememberDemoBar(barId);
  return true;
}

export const rememberedDemoBar = (bars: readonly BarSummary[]) => rememberedBar(bars, DEMO_LAST);
export const rememberDemoBar = (id: string) => rememberBar(id, DEMO_LAST);

/** The bar this browser's counter is for (demo), once its code was typed. */
export function counterBar(): BarSummary | null {
  const id = read<string>(COUNTER_BAR);
  const bar = id ? platform().bars.find((b) => b.id === id) : undefined;
  return bar ? summary(bar) : null;
}

export function rememberCounterBar(id: string | null): void {
  write(COUNTER_BAR, id);
}

/**
 * The sample bar keeps the admin store it always had (the sample night); the
 * counter's sample store is the default one (src/data/db.ts). Every other
 * demo bar has one store, shared by admin and the counter.
 */
export function demoStoreName(barId: string): string {
  return barId === DEMO_SAMPLE_BAR ? 'kaunta-admin-demo' : `kaunta-bar-${barId}`;
}

const demoStores = new Map<string, KauntaDB>();
export function demoStore(barId: string): KauntaDB {
  let db = demoStores.get(barId);
  // A store deleted meanwhile (starting a bar's data again) needs a new connection.
  if (!db || db.hasBeenClosed()) {
    db = new KauntaDB(demoStoreName(barId));
    demoStores.set(barId, db);
  }
  return db;
}

/**
 * The `people` row an owner or manager account has in a bar. It carries the
 * hash of their password (owners) or PIN (managers), so they can also sign
 * in at the bar's counter, offline like everyone else.
 */
function personFor(account: Account, role: MemberRole, pin_hash: string | null): Person {
  return {
    id: account.person_id,
    name: account.name,
    initial: account.initial,
    colour: account.colour,
    role,
    login: account.secret === 'password' ? 'password' : 'pin',
    pin_hash,
    pin_locked_until: null,
    failed_pin_attempts: 0,
    archived_at: null,
  };
}

/** Everyone who may run the bar has a `people` row in its store (a manager added later, say), with their current password or PIN. */
export async function ensureMemberPeople(db: KauntaDB, barId: string): Promise<void> {
  for (const { account, role } of membersOf(barId)) {
    const hash = await secretHash(account.id);
    const row = await db.people.get(account.person_id);
    const wanted = personFor(account, role, hash);
    if (!row) await db.people.put(wanted);
    else if (row.pin_hash !== hash || row.login !== wanted.login || row.role !== role || row.archived_at) {
      // A new password or PIN unlocks them at the counter too; a manager added back is back on its list.
      await db.people.update(row.id, { pin_hash: hash, login: wanted.login, role, pin_locked_until: null, failed_pin_attempts: 0, archived_at: null });
    }
  }
}

/** The stores a bar has on this browser: its own, and for the sample bar the counter's too (once it has been opened). */
async function storesOf(barId: string, open?: KauntaDB): Promise<KauntaDB[]> {
  const stores = [open ?? demoStore(barId)];
  if (barId === DEMO_SAMPLE_BAR && (await sampleCounterDb.meta.get('seeded'))) stores.push(sampleCounterDb);
  return stores;
}

/**
 * A manager now runs this bar (demo): their `people` row goes into its store
 * as an audited admin event by the owner ("Added X · Admin"), so they can open
 * it in admin and sign in at its counter with their PIN.
 */
export async function managerAdded(owner: Account, manager: Account, barId: string, open?: KauntaDB): Promise<void> {
  const [store, ...others] = await storesOf(barId, open);
  const person = personFor(manager, 'admin', await secretHash(manager.id));
  await recordAdminEvent(store!, { person_id: owner.person_id }, { type: 'person_saved', payload: { person } });
  for (const db of others) await ensureMemberPeople(db, barId);
}

/** A manager no longer runs this bar: off its counter's list and out of its admin (audited); their history stays. */
export async function managerRemoved(owner: Account, manager: Account, barId: string, open?: KauntaDB): Promise<void> {
  const [store, ...others] = await storesOf(barId, open);
  if (await store!.people.get(manager.person_id)) {
    await recordAdminEvent(store!, { person_id: owner.person_id }, { type: 'person_archived', payload: { person_id: manager.person_id } });
  }
  for (const db of others) await db.people.update(manager.person_id, { archived_at: new Date().toISOString() });
}

/**
 * After an account's password or PIN changes: every store of its bars on this
 * browser takes the new hash (the sample bar has two, admin's and the counter's).
 */
export async function syncAccountPeople(accountId: string): Promise<void> {
  const p = platform();
  for (const m of p.members.filter((x) => x.account_id === accountId)) {
    await ensureMemberPeople(demoStore(m.bar_id), m.bar_id);
    if (m.bar_id === DEMO_SAMPLE_BAR) {
      if (await sampleCounterDb.meta.get('seeded')) await ensureMemberPeople(sampleCounterDb, m.bar_id);
    }
  }
}

/**
 * A bar that has just started, on real time: its settings and code, the
 * categories, its owner and managers, and this browser as its counter phone.
 * No products and no counter staff yet: admin starts with first run, and the
 * owner adds staff (each gets a one-time code to choose their PIN).
 */
export async function seedNewDemoBar(db: KauntaDB, bar: Pick<BarSummary, 'id' | 'name' | 'counter_code'>): Promise<boolean> {
  if (await db.meta.get('seeded')) {
    await ensureMemberPeople(db, bar.id);
    return false;
  }
  const seed = loadSeed();
  const now = new Date().toISOString();
  const deviceId = `${bar.id}:browser`;
  const owner = membersOf(bar.id).find((m) => m.role === 'owner');
  const created = await db.transaction('rw', db.tables, async () => {
    if (await db.meta.get('seeded')) return false;
    await db.bar.add({ ...seed.bar, id: bar.id, name: bar.name, counter_code: bar.counter_code });
    await db.categories.bulkAdd(defaultCategories());
    await db.devices.add({ id: deviceId, name: 'This browser', model: 'browser', paired_at: now, paired_by: owner?.account.person_id ?? 'system', revoked_at: null, revoked_reason: null, last_sync_at: now });
    await db.meta.bulkAdd([
      { key: 'seeded', value: now },
      { key: 'clock_offset_ms', value: 0 },
      { key: 'device_id', value: deviceId },
    ]);
    return true;
  });
  await ensureMemberPeople(db, bar.id);
  return created;
}
