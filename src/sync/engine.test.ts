import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordOrder, recordPayment } from '../data/commands';
import { KauntaDB } from '../data/db';
import { outboxCounts, pendingEvents } from '../data/outbox';
import type { RecordContext } from '../data/outbox';
import { seedDatabase } from '../data/seedDb';
import { syncPillStatus } from '../lib/sync';
import { applyPull, normaliseRow } from './apply';
import { serverConfig } from './config';
import { SyncEngine, backoffDelay } from './engine';
import { SupabaseTransport, TransportError } from './transport';
import type { PullData, PullResponse, PushResponse, SyncTransport, WireEvent } from './transport';

let db: KauntaDB;
let n = 0;
const ctx: RecordContext = { person_id: 'p_wanjiku', device_id: 'd_counter1', now: () => new Date('2026-11-10T19:20:00.000Z') };
const sale = () => recordOrder(db, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'soda_0', qty: 1 }] });

const emptyPull = (extra: Partial<PullData> = {}): PullData => ({
  cursor: '2026-11-10T19:19:30+00:00',
  server_time: '2026-11-10T19:20:00+00:00',
  bar: [], categories: [], people: [], devices: [], products: [], sizes: [], kegs: [],
  orders: [], lines: [], payments: [], approvals: [], shifts: [],
  ...extra,
});

/** A scripted server: accepts everything unless told otherwise, and records what it was sent. */
class FakeServer implements SyncTransport {
  pushes: WireEvent[][] = [];
  pulls: (string | null)[] = [];
  failNext = 0;
  review = new Map<string, { reason: string; detail: Record<string, unknown> }>();
  shortNo = new Map<string, string>();
  pullData: PullResponse = emptyPull();
  onPush?: () => Promise<void>;

  async push(_token: string, events: WireEvent[]): Promise<PushResponse> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new TransportError('network: offline');
    }
    this.pushes.push(events);
    await this.onPush?.();
    return {
      server_time: '2026-11-10T19:21:00+00:00',
      results: events.map((e) => {
        const orderId = e.type === 'order_recorded' ? e.payload.order.id : undefined;
        const flagged = this.review.get(e.id);
        return {
          id: e.id,
          status: flagged ? 'needs_review' : 'applied',
          reason: flagged?.reason ?? null,
          detail: flagged?.detail ?? null,
          result: orderId && this.shortNo.has(orderId) ? { order_id: orderId, short_no: this.shortNo.get(orderId)! } : null,
          duplicate: false,
        };
      }),
    };
  }

  async pull(_token: string, since: string | null): Promise<PullResponse> {
    this.pulls.push(since);
    return this.pullData;
  }

  async pair() {
    return { error: 'invalid_code' as const };
  }
}

let server: FakeServer;
let timers: { run: () => void; ms: number }[];
const engine = (opts = {}) =>
  new SyncEngine(db, server, {
    batchSize: 2,
    random: () => 1, // no jitter: delays are exact
    now: () => 1_000_000,
    setTimer: (run, ms) => timers.push({ run, ms }),
    clearTimer: () => {},
    ...opts,
  });

beforeEach(async () => {
  db = new KauntaDB(`kaunta-engine-${++n}`);
  await seedDatabase(db);
  await db.meta.put({ key: 'device_token', value: 'secret-token' });
  server = new FakeServer();
  timers = [];
});
afterEach(() => db.delete());

describe('backoffDelay', () => {
  const opts = { baseDelayMs: 1000, maxDelayMs: 300_000 };
  it('doubles from 1s up to 5 minutes, with jitter between half and all of it', () => {
    expect([1, 2, 3, 4, 5].map((f) => backoffDelay(f, opts, () => 1))).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(backoffDelay(20, opts, () => 1)).toBe(300_000);
    expect(backoffDelay(3, opts, () => 0)).toBe(2000);
  });
});

describe('SyncEngine', () => {
  it('sends the outbox oldest first, in batches, and marks everything sent', async () => {
    for (let i = 0; i < 5; i++) await sale();
    const order = (await pendingEvents(db)).map((e) => e.id);
    await engine().runOnce();

    expect(server.pushes.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(server.pushes.flat().map((e) => e.id)).toEqual(order);
    expect(await outboxCounts(db)).toEqual({ queued: 0, needsAdmin: 0 });
    const sent = await db.outbox.toArray();
    expect(sent.every((e) => e.status === 'sent' && e.synced_at === '2026-11-10T19:21:00.000Z' && e.attempts === 1)).toBe(true);
  });

  it('sends only the event, not this phone’s queue bookkeeping, with the device token', async () => {
    await sale();
    await engine().runOnce();
    expect(Object.keys(server.pushes[0]![0]!).sort()).toEqual(['created_at', 'device_id', 'id', 'payload', 'recorded_by', 'type']);
  });

  it('on a failure it stops where it is, skips nothing, and retries with growing waits', async () => {
    for (let i = 0; i < 3; i++) await sale();
    const order = (await pendingEvents(db)).map((e) => e.id);
    server.failNext = 2;
    const sync = engine();

    await sync.runOnce();
    expect(sync.getState()).toMatchObject({ failures: 1, lastError: 'network: offline', nextRetryAt: 1_001_000, sending: 0 });
    expect(timers.at(-1)!.ms).toBe(1000);
    expect((await outboxCounts(db)).queued).toBe(3);

    timers.at(-1)!.run();
    await sync.runOnce();
    expect(sync.getState().failures).toBe(2);
    expect(timers.at(-1)!.ms).toBe(2000);

    timers.at(-1)!.run();
    await sync.runOnce();
    expect(sync.getState()).toMatchObject({ failures: 0, lastError: null, nextRetryAt: null });
    expect(server.pushes.flat().map((e) => e.id)).toEqual(order);
    // The first batch of two was tried three times; the third event only went once, after them.
    expect((await db.outbox.toArray()).map((e) => e.attempts)).toEqual([3, 3, 1]);
  });

  it('marks what the server flagged as needs admin, keeps going, and the pill turns yellow', async () => {
    await sale();
    await sale();
    const [first, second] = await pendingEvents(db);
    server.review.set(first!.id, { reason: 'price_mismatch', detail: { recorded_price_kes: 300, server_price_kes: 320 } });
    await engine().runOnce();

    expect(await db.outbox.where('id').equals(first!.id).first()).toMatchObject({
      status: 'needs_review',
      review_reason: 'price_mismatch',
      review_detail: { recorded_price_kes: 300, server_price_kes: 320 },
    });
    expect((await db.outbox.where('id').equals(second!.id).first())?.status).toBe('sent');
    expect(syncPillStatus({ online: true, sending: 0, ...(await outboxCounts(db)) })).toEqual({ state: 'needsAdmin', count: 1 });
  });

  it('R-DAY-2 takes the server’s final order number', async () => {
    const order = await sale();
    expect(order).toMatchObject({ short_no: '#049', short_no_provisional: true });
    server.shortNo.set(order.id, '#051');
    await engine().runOnce();
    expect(await db.orders.get(order.id)).toMatchObject({ short_no: '#051', short_no_provisional: false });
  });

  it('reports "Sending N…" while a batch is in flight', async () => {
    await sale();
    const sync = engine();
    const seen: number[] = [];
    sync.subscribe(() => seen.push(sync.getState().sending));
    await sync.runOnce();
    expect(seen).toContain(1);
    expect(sync.getState().sending).toBe(0);
  });

  it('pulls after sending, from the saved cursor, and writes the rows with normalised times', async () => {
    server.pullData = emptyPull({
      products: [{ id: 'tusker', category_id: 'beer', name: 'Tusker Lager', name_sw: null, stock_mode: 'count', stock_qty: 30, low_stock_at: 6, manual_out_of_stock: false, archived_at: null, sort: 0 }],
      people: [{ id: 'p_kiprop', name: 'Kiprop', initial: 'K', colour: '#9ED9B8', role: 'counter', login: 'pin', pin_hash: null, pin_locked_until: '2026-11-10T19:25:00+00:00', failed_pin_attempts: 5, archived_at: null }],
    });
    const sync = engine();
    await sync.runOnce();
    expect(server.pulls).toEqual([null]);
    expect((await db.products.get('tusker'))?.stock_qty).toBe(30);
    expect((await db.people.get('p_kiprop'))?.pin_locked_until).toBe('2026-11-10T19:25:00.000Z'); // a lock from another counter
    expect((await db.meta.get('pull_cursor'))?.value).toBe('2026-11-10T19:19:30.000Z');
    expect((await db.meta.get('last_sync_at'))?.value).toBe('2026-11-10T19:20:00.000Z');

    await sync.runOnce();
    expect(server.pulls).toEqual([null, '2026-11-10T19:19:30.000Z']);
  });

  it('never lets pulled rows overwrite a change the server has not seen yet', async () => {
    await recordPayment(db, ctx, 'o_048', [{ method: 'cash', amount_kes: 600 }]); // paid on this phone, not yet sent
    const stale = emptyPull({ orders: [{ ...(await db.orders.get('o_048'))!, status: 'open' }] });
    expect(await applyPull(db, stale)).toBe(false);
    expect((await db.orders.get('o_048'))?.status).toBe('paid');
  });

  it('if something is recorded while it pulls, it sends that first, then pulls again', async () => {
    server.onPush = async () => {
      server.onPush = undefined;
    };
    let recordedDuringPull = false;
    const originalPull = server.pull.bind(server);
    server.pull = async (token, since) => {
      if (!recordedDuringPull) {
        recordedDuringPull = true;
        await sale(); // a sale lands mid-pull
      }
      return originalPull(token, since);
    };
    await engine().runOnce();
    expect(server.pushes.flat()).toHaveLength(1);
    expect(server.pulls).toHaveLength(2);
    expect((await outboxCounts(db)).queued).toBe(0);
  });

  it('stops trying when the server does not know this phone', async () => {
    await sale();
    server.push = async () => ({ error: 'unknown_device' });
    const sync = engine();
    await sync.runOnce();
    expect(sync.getState()).toMatchObject({ stopped: 'unpaired', lastError: 'unknown_device' });
    expect((await outboxCounts(db)).queued).toBe(1); // still kept
  });

  it('a revoked phone is told so on pull', async () => {
    server.pullData = { error: 'revoked_device' };
    const sync = engine();
    await sync.runOnce();
    expect(sync.getState().stopped).toBe('revoked');
  });

  it('does nothing without a device token', async () => {
    await db.meta.delete('device_token');
    await sale();
    const sync = engine();
    await sync.runOnce();
    expect(server.pushes).toEqual([]);
    expect(sync.getState().stopped).toBe('unpaired');
  });

  it('Send now skips the wait after a failure', async () => {
    await sale();
    server.failNext = 1;
    const sync = engine();
    await sync.runOnce();
    expect(sync.getState().nextRetryAt).not.toBeNull();
    await sync.syncNow();
    expect(sync.getState()).toMatchObject({ failures: 0, nextRetryAt: null });
    expect((await outboxCounts(db)).queued).toBe(0);
  });
});

describe('normaliseRow', () => {
  it('rewrites instants to one ISO form and leaves everything else alone', () => {
    expect(
      normaliseRow({ created_at: '2026-11-10T19:20:00+00:00', pin_locked_until: '2026-11-10T22:25:00.5+03:00', business_day: '2026-11-10', label: 'x', closed_at: null, qty: 2 }),
    ).toEqual({ created_at: '2026-11-10T19:20:00.000Z', pin_locked_until: '2026-11-10T19:25:00.500Z', business_day: '2026-11-10', label: 'x', closed_at: null, qty: 2 });
  });
});

describe('SupabaseTransport', () => {
  const config = { url: 'https://abc.supabase.co', anonKey: 'anon-key' };

  it('calls the RPC functions with the anon key and the device token in the body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transport = new SupabaseTransport(config, async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ server_time: 'x', results: [] }), { status: 200 });
    });
    await transport.push('tok', []);
    expect(calls[0]!.url).toBe('https://abc.supabase.co/rest/v1/rpc/sync_push');
    expect(calls[0]!.init.headers).toMatchObject({ apikey: 'anon-key', Authorization: 'Bearer anon-key' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ p_token: 'tok', p_events: [] });
  });

  it('turns no network and server errors into a retryable TransportError', async () => {
    const offline = new SupabaseTransport(config, async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(offline.pull('tok', null)).rejects.toThrow(TransportError);
    const broken = new SupabaseTransport(config, async () => new Response('oops', { status: 503 }));
    await expect(broken.pull('tok', null)).rejects.toMatchObject({ status: 503 });
  });

  it('reads its settings from the environment, and is off without them', () => {
    expect(serverConfig({})).toBeNull();
    expect(serverConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co/', VITE_SUPABASE_ANON_KEY: ' k ' })).toEqual({
      url: 'https://abc.supabase.co',
      anonKey: 'k',
    });
  });
});
