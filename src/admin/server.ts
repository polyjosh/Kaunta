import { liveQuery } from 'dexie';
import type { AdminOutboxEntry } from '../data/adminEvents';
import type { KauntaDB } from '../data/db';
import type { Id, Instant } from '../domain/types';
import type { ServerConfig } from '../sync/config';
import { backoffDelay } from '../sync/engine';
import { normaliseRow } from '../sync/apply';
import { PULL_TABLES, TransportError } from '../sync/transport';
import type { Row } from '../sync/transport';
import type { PairingCode } from './AdminSession';

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  /** ms since epoch */
  expires_at: number;
  user_id: string;
}

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
type AdminPull = { me: Id; cursor: Instant; server_time: Instant } & Record<(typeof ADMIN_TABLES)[number], Row[]>;
interface AdminPushResult {
  id: Id;
  status: 'applied' | 'rejected';
  reason: string | null;
}

const STORAGE_KEY = 'kaunta.adminAuth';

/** Supabase Auth and the three admin functions, over plain fetch (like the counter's transport). */
export class AdminServer {
  private session: AuthSession | null;

  constructor(
    private readonly config: ServerConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
  ) {
    this.session = this.load();
  }

  private load(): AuthSession | null {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as AuthSession) : null;
    } catch {
      return null;
    }
  }

  private save(session: AuthSession | null): void {
    this.session = session;
    try {
      if (session) this.storage?.setItem(STORAGE_KEY, JSON.stringify(session));
      else this.storage?.removeItem(STORAGE_KEY);
    } catch {
      // A session that is not remembered just means signing in again.
    }
  }

  get signedIn(): boolean {
    return this.session !== null;
  }

  private async auth(grant: 'password' | 'refresh_token', body: object): Promise<AuthSession> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/auth/v1/token?grant_type=${grant}`, {
        method: 'POST',
        headers: { apikey: this.config.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new TransportError(`network: ${(error as Error).message}`);
    }
    if (response.status === 400 || response.status === 401) throw new TransportError('wrong_password', response.status);
    if (!response.ok) throw new TransportError(`server answered ${response.status}`, response.status);
    const data = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number; user: { id: string } };
    const session = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000, user_id: data.user.id };
    this.save(session);
    return session;
  }

  async signIn(login: string, password: string): Promise<void> {
    await this.auth('password', { ...normaliseLogin(login), password });
  }

  signOut(): void {
    this.save(null);
  }

  /** A valid access token, refreshed a minute before it runs out. */
  private async token(): Promise<string> {
    if (!this.session) throw new TransportError('signed_out', 401);
    if (this.session.expires_at - Date.now() < 60_000) {
      try {
        await this.auth('refresh_token', { refresh_token: this.session.refresh_token });
      } catch (error) {
        if ((error as TransportError).status === 400 || (error as TransportError).status === 401) this.save(null);
        throw error;
      }
    }
    return this.session!.access_token;
  }

  private async rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: this.config.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new TransportError(`network: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new TransportError(text.includes('not_admin') ? 'not_admin' : `server answered ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }

  pull(since: Instant | null) {
    return this.rpc<AdminPull>('admin_pull', { p_since: since });
  }

  push(events: object[]) {
    return this.rpc<{ server_time: Instant; results: AdminPushResult[] }>('admin_push', { p_events: events });
  }

  createPairingCode = (deviceName: string): Promise<PairingCode> =>
    this.rpc<PairingCode>('admin_create_pairing_code', { p_device_name: deviceName });
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
    private readonly server: Pick<AdminServer, 'push' | 'pull'>,
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
