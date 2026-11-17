import { liveQuery } from 'dexie';
import type { KauntaDB } from '../data/db';
import { noteAttempt, pendingEvents } from '../data/outbox';
import { applyPull, applyPushResults } from './apply';
import { toWire } from './transport';
import type { SyncTransport } from './transport';

export interface EngineState {
  /** Events in the request now in flight ("Sending 3…"). */
  sending: number;
  /** Consecutive failed attempts; resets on success. */
  failures: number;
  lastError: string | null;
  /** When the next retry is due (ms since epoch), while backing off. */
  nextRetryAt: number | null;
  /** Why the engine has stopped trying, if it has. */
  /** 'suspended': Kaunta suspended the bar; the periodic pull carries on and clears it once access is given back. */
  stopped: 'unpaired' | 'revoked' | 'suspended' | null;
}

export interface EngineOptions {
  batchSize?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** How often to pull when idle, for other counters' sales and admin changes. */
  pullEveryMs?: number;
  random?: () => number;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULTS = {
  batchSize: 25,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  pullEveryMs: 60_000,
};

/** Exponential backoff with jitter: about 1s, 2s, 4s … capped at 5 minutes. */
export function backoffDelay(failures: number, opts: { baseDelayMs: number; maxDelayMs: number }, random: () => number): number {
  const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** Math.max(0, failures - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/**
 * R-SYNC-2: sends the outbox in the order things happened, in batches, and
 * marks each event sent or "needs admin" from the server's answer. On any
 * failure it stops where it is (nothing is skipped) and retries with
 * backoff. When the queue is empty it pulls what changed on the server.
 */
export class SyncEngine {
  private state: EngineState = { sending: 0, failures: 0, lastError: null, nextRetryAt: null, stopped: null };
  private readonly listeners = new Set<() => void>();
  private readonly opts: Required<EngineOptions>;
  private timer: unknown = null;
  private pullTimer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private unsubscribeQueue: (() => void) | null = null;
  private readonly onOnline = () => void this.syncNow();

  constructor(
    private readonly db: KauntaDB,
    private readonly transport: SyncTransport,
    options: EngineOptions = {},
  ) {
    this.opts = {
      ...DEFAULTS,
      random: Math.random,
      now: Date.now,
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  getState = (): EngineState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Starts watching: new outbox entries, the network coming back, and a periodic pull. */
  start(): void {
    const subscription = liveQuery(() => this.db.outbox.where('status').equals('pending').count()).subscribe({
      next: (pending) => {
        // A new record goes out at once, unless we are waiting out a failure.
        if (pending > 0 && this.state.nextRetryAt === null) void this.runOnce();
      },
    });
    this.unsubscribeQueue = () => subscription.unsubscribe();
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);
    const tick = () => {
      if (this.state.nextRetryAt === null) void this.runOnce();
      this.pullTimer = this.opts.setTimer(tick, this.opts.pullEveryMs);
    };
    this.pullTimer = this.opts.setTimer(tick, this.opts.pullEveryMs);
    void this.runOnce();
  }

  stop(): void {
    this.unsubscribeQueue?.();
    this.unsubscribeQueue = null;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    if (this.timer !== null) this.opts.clearTimer(this.timer);
    if (this.pullTimer !== null) this.opts.clearTimer(this.pullTimer);
    this.timer = this.pullTimer = null;
  }

  /** "Send now", or the network came back: skip any wait and try at once. */
  syncNow(): Promise<void> {
    if (this.timer !== null) this.opts.clearTimer(this.timer);
    this.timer = null;
    this.set({ nextRetryAt: null });
    return this.runOnce();
  }

  /** One full pass. Concurrent calls share the pass in flight, and one more pass follows if asked for. */
  runOnce(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && this.state.nextRetryAt === null && this.state.stopped === null);
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pass(): Promise<void> {
    const token = (await this.db.meta.get('device_token'))?.value;
    if (typeof token !== 'string') {
      this.set({ stopped: 'unpaired' });
      return;
    }
    try {
      for (;;) {
        const batch = (await pendingEvents(this.db)).slice(0, this.opts.batchSize);
        if (batch.length === 0) break;
        this.set({ sending: batch.length });
        await noteAttempt(this.db, batch.map((e) => e.id));
        const response = await this.transport.push(token, batch.map(toWire));
        if ('error' in response) {
          this.set({ sending: 0, stopped: response.error === 'bar_suspended' ? 'suspended' : 'unpaired', lastError: response.error });
          return;
        }
        await applyPushResults(this.db, batch, response.results, response.server_time);
      }
      this.set({ sending: 0 });

      const pulled = await this.transport.pull(token, ((await this.db.meta.get('pull_cursor'))?.value as string) ?? null);
      if ('error' in pulled) {
        // A revoked phone keeps sending (the server quarantines), but gets nothing back.
        this.set({ stopped: pulled.error === 'revoked_device' ? 'revoked' : pulled.error === 'bar_suspended' ? 'suspended' : 'unpaired', lastError: pulled.error });
        return;
      }
      // If something was recorded while we pulled, go round again before writing.
      if (!(await applyPull(this.db, pulled))) this.again = true;
      this.set({ failures: 0, lastError: null, nextRetryAt: null, stopped: null });
    } catch (error) {
      const failures = this.state.failures + 1;
      const delay = backoffDelay(failures, this.opts, this.opts.random);
      this.set({ sending: 0, failures, lastError: (error as Error).message, nextRetryAt: this.opts.now() + delay });
      if (this.timer !== null) this.opts.clearTimer(this.timer);
      this.timer = this.opts.setTimer(() => {
        this.timer = null;
        this.set({ nextRetryAt: null });
        void this.runOnce();
      }, delay);
    }
  }
}
