import { liveQuery } from 'dexie';
import type { AdminOutboxEntry } from '../data/adminEvents';
import type { KauntaDB } from '../data/db';
import type { Id, Instant } from '../domain/types';
import { restHeaders } from '../sync/config';
import type { ServerConfig } from '../sync/config';
import type { Account, Platform } from '../platform/platform';
import { backoffDelay } from '../sync/engine';
import { normaliseRow } from '../sync/apply';
import { PULL_TABLES, TransportError } from '../sync/transport';
import type { Row } from '../sync/transport';
import type { PairingCode } from './AdminSession';
import type { BarSummary } from './bars';

export type SignInError = 'wrong_password' | 'network' | 'server';

/** Kenyan numbers as people type them ("0712 345 678", "712345678", "+254 712…") → "+254712345678". Emails pass through. */
export function normaliseLogin(input: string): { phone: string } | { email: string } {
  const value = input.trim();
  if (value.includes('@')) return { email: value.toLowerCase() };
  const digits = value.replace(/[^\d]/g, '');
  if (digits.startsWith('254')) return { phone: `+${digits}` };
  if (digits.startsWith('0')) return { phone: `+254${digits.slice(1)}` };
  if (digits.length === 9) return { phone: `+254${digits}` };
  return { phone: value.startsWith('+') ? `+${digits}` : digits };
}

const ADMIN_TABLES = [...PULL_TABLES, 'deliveries', 'dayCloses', 'stockMovements', 'auditEvents'] as const;
export type AdminPull = { me: Id; cursor: Instant; server_time: Instant } & Record<(typeof ADMIN_TABLES)[number], Row[]>;
interface AdminPushResult {
  id: Id;
  status: 'applied' | 'rejected';
  reason: string | null;
}

/** What the server says back when it refuses a call (raised in the migrations). */
const KNOWN_REASONS = ['not_admin', 'not_owner', 'name_required', 'bar_limit', 'bar_suspended', 'signed_out'] as const;

/** An account's sign-in answer (account_sign_in), shaped like the demo's signIn(). */
export type AccountSignIn =
  | { ok: true; account: Account }
  | { ok: false; reason: 'wrong'; triesLeft: number | null }
  | { ok: false; reason: 'locked'; until: Instant };

/** Who is signed in and what Kaunta lets them do (admin_me). */
export interface AccountMe {
  account: Account;
  bar_limit: { used: number; max: number | null };
  /** Names of their bars Kaunta suspended. */
  suspended: string[];
}

export type ServerAnswer = { error: string } | { ok: true };

const STORAGE_KEY = 'kaunta.adminSession';
const SUPER_STORAGE_KEY = 'kaunta.superServerSession';

/**
 * The server for owners and managers (or, with `kaunta`, for Kaunta), over
 * plain fetch like the counter's transport. Sign-in gives a session token;
 * every call goes through kaunta_admin (or kaunta_super) with it, sent with
 * the publishable key only.
 */
export class AdminServer {
  private session: string | null;

  constructor(
    private readonly config: ServerConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
    readonly kaunta = false,
  ) {
    this.session = this.load();
  }

  private get key() {
    return this.kaunta ? SUPER_STORAGE_KEY : STORAGE_KEY;
  }

  private load(): string | null {
    try {
      return this.storage?.getItem(this.key) ?? null;
    } catch {
      return null;
    }
  }

  private save(session: string | null): void {
    this.session = session;
    try {
      if (session) this.storage?.setItem(this.key, session);
      else this.storage?.removeItem(this.key);
    } catch {
      // A session that is not remembered just means signing in again.
    }
  }

  get signedIn(): boolean {
    return this.session !== null;
  }

  private async post<T>(fn: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: restHeaders(this.config), body: JSON.stringify(body) });
    } catch (error) {
      throw new TransportError(`network: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const known = KNOWN_REASONS.find((reason) => text.includes(reason));
      if (known === 'signed_out') this.save(null);
      throw new TransportError(known ?? `server answered ${response.status}`, response.status);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** One call through the entry point, with this session. */
  call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.session) return Promise.reject(new TransportError('signed_out', 401));
    return this.post<T>(this.kaunta ? 'kaunta_super' : 'kaunta_admin', { p_session: this.session, p_call: fn, p_args: args });
  }

  /** Owners: username + password; managers: username + PIN. */
  async signIn(username: string, secret: string): Promise<AccountSignIn> {
    const r = await this.post<{ ok: boolean; token?: string; account?: Account; reason?: 'wrong' | 'locked'; tries_left?: number | null; until?: Instant }>(
      'account_sign_in',
      { p_username: username, p_secret: secret },
    );
    if (r.ok && r.token && r.account) {
      this.save(r.token);
      return { ok: true, account: r.account };
    }
    return r.reason === 'locked' ? { ok: false, reason: 'locked', until: r.until! } : { ok: false, reason: 'wrong', triesLeft: r.tries_left ?? null };
  }

  /** Kaunta: its password. */
  async superSignIn(password: string): Promise<'ok' | 'wrong' | 'locked' | 'not_set'> {
    const r = await this.post<{ ok: boolean; token?: string; reason?: 'wrong' | 'locked' | 'not_set' }>('super_sign_in', { p_password: password });
    if (r.ok && r.token) {
      this.save(r.token);
      return 'ok';
    }
    return r.reason ?? 'wrong';
  }

  signOut(): void {
    const session = this.session;
    this.save(null);
    if (session) void this.post(this.kaunta ? 'super_sign_out' : 'account_sign_out', { p_session: session }).catch(() => {});
  }

  /** The bars this sign-in may run (owner or admin in each; suspended bars left out). */
  bars = (): Promise<BarSummary[]> => this.call<BarSummary[]>('admin_bars');

  /** An owner starts another bar (within Kaunta's limit); they are its owner. */
  createBar = (name: string): Promise<BarSummary> => this.call<BarSummary>('admin_create_bar', { p_name: name });

  me = (): Promise<AccountMe> => this.call<AccountMe>('admin_me');

  /** An owner's platform (their account, managers, bars and who runs them); Kaunta's is everything. */
  platform = (): Promise<Platform> => this.call<Platform>(this.kaunta ? 'super_platform' : 'admin_platform');

  changeSecret = (current: string, next: string, counterHash: string) =>
    this.call<ServerAnswer>('admin_change_secret', { p_current: current, p_next: next, p_counter_hash: counterHash });

  createManager = (barIds: string[], input: { name: string; username: string; pin: string }, counterHash: string) =>
    this.call<{ account: Account } | { error: string }>('admin_create_manager', {
      p_bar_ids: barIds, p_name: input.name, p_username: input.username, p_pin: input.pin, p_counter_hash: counterHash,
    });

  addManager = (accountId: string, barId: string) => this.call<ServerAnswer>('admin_add_manager', { p_account: accountId, p_bar: barId });

  removeManager = (accountId: string, barId: string) => this.call<ServerAnswer>('admin_remove_manager', { p_account: accountId, p_bar: barId });

  /** The admin functions for one bar. The server checks this sign-in may run it. */
  forBar(barId: string): BarServer {
    return {
      pull: (since) => this.call<AdminPull>('admin_pull', { p_bar_id: barId, p_since: since }),
      push: (events) => this.call<{ server_time: Instant; results: AdminPushResult[] }>('admin_push', { p_bar_id: barId, p_events: events }),
      createPairingCode: (deviceName) => this.call<PairingCode>('admin_create_pairing_code', { p_bar_id: barId, p_device_name: deviceName }),
      changeBarCode: async (code) => {
        const answer = code
          ? await this.call<{ counter_code?: string; error?: 'invalid' | 'taken' }>('admin_set_bar_code', { p_bar_id: barId, p_code: code })
          : await this.call<{ counter_code: string }>('admin_new_bar_code', { p_bar_id: barId });
        return 'error' in answer && answer.error ? { error: answer.error } : { code: answer.counter_code! };
      },
    };
  }
}

export type BarCodeChange = { code: string } | { error: 'invalid' | 'taken' };

export interface BarServer {
  pull(since: Instant | null): Promise<AdminPull>;
  push(events: object[]): Promise<{ server_time: Instant; results: AdminPushResult[] }>;
  createPairingCode(deviceName: string): Promise<PairingCode>;
  /** Owners: the bar's code becomes the one they chose (if no other bar has it), or a fresh one. */
  changeBarCode(code?: string): Promise<BarCodeChange>;
}

const wire = (e: AdminOutboxEntry) => ({ id: e.id, type: e.type, payload: e.payload, created_at: e.created_at });

/** Writes a pull into the admin store, unless something the server has not seen is still waiting. */
export async function applyAdminPull(db: KauntaDB, data: AdminPull): Promise<boolean> {
  return db.transaction('rw', db.tables, async () => {
    if ((await db.adminOutbox.where('status').equals('pending').count()) > 0) return false;
    for (const table of ADMIN_TABLES) {
      const rows = data[table] ?? [];
      if (rows.length > 0) await db.table(table).bulkPut(rows.map(normaliseRow));
    }
    await db.meta.bulkPut([
      { key: 'pull_cursor', value: new Date(data.cursor).toISOString() },
      { key: 'last_sync_at', value: new Date(data.server_time).toISOString() },
      { key: 'me', value: data.me },
    ]);
    return true;
  });
}

/**
 * Keeps the admin store in step with the server: sends the admin's changes
 * in order, then pulls what changed (the feed's "live"), every 20 seconds and
 * whenever something is recorded. Backs off on failure; never drops a change.
 */
export class AdminSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private unsubscribe: (() => void) | null = null;
  /** Why the last change the server refused was refused, for the screen to show. */
  lastRejected: string | null = null;

  constructor(
    private readonly db: KauntaDB,
    private readonly server: Pick<BarServer, 'push' | 'pull'>,
    private readonly everyMs = 20_000,
  ) {}

  start(): void {
    const sub = liveQuery(() => this.db.adminOutbox.where('status').equals('pending').count()).subscribe({
      next: (n) => {
        if (n > 0 && this.failures === 0) void this.run();
      },
    });
    this.unsubscribe = () => sub.unsubscribe();
    void this.run();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), ms);
  }

  private async pass(): Promise<void> {
    try {
      for (;;) {
        const batch = (await this.db.adminOutbox.where('status').equals('pending').sortBy('seq')).slice(0, 25);
        if (batch.length === 0) break;
        const { results, server_time } = await this.server.push(batch.map(wire));
        const byId = new Map(results.map((r) => [r.id, r]));
        if (batch.some((e) => !byId.has(e.id))) throw new Error('server did not answer for every change');
        await this.db.transaction('rw', this.db.adminOutbox, this.db.auditEvents, this.db.meta, async () => {
          for (const e of batch) {
            const r = byId.get(e.id)!;
            await this.db.adminOutbox.where('id').equals(e.id).modify(
              r.status === 'applied'
                ? { status: 'sent', synced_at: new Date(server_time).toISOString() }
                : { status: 'needs_review', synced_at: new Date(server_time).toISOString(), review_reason: r.reason },
            );
            if (r.status === 'applied') await this.db.auditEvents.update(e.id, { synced_at: new Date(server_time).toISOString() });
            else {
              this.lastRejected = r.reason;
              // What was shown locally did not happen on the server: start again from the server's rows.
              await this.db.meta.delete('pull_cursor');
            }
          }
        });
      }
      const since = ((await this.db.meta.get('pull_cursor'))?.value as string | undefined) ?? null;
      const data = await this.server.pull(since);
      if (!(await applyAdminPull(this.db, data))) this.again = true;
      this.failures = 0;
      this.schedule(this.everyMs);
    } catch {
      this.failures += 1;
      this.schedule(backoffDelay(this.failures, { baseDelayMs: 1_000, maxDelayMs: 5 * 60_000 }, Math.random));
    }
  }
}
