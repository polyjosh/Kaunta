import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { recordOrder } from '../data/commands';
import { KauntaDB } from '../data/db';
import { pendingEvents } from '../data/outbox';
import { loadSeed } from '../domain/seed';
import type { PairResponse, PullData, PullResponse, PushResponse, SyncTransport, WireEvent } from './transport';
import { TransportError } from './transport';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();

/** A server holding the handoff sample data. */
class FakeServer implements SyncTransport {
  codes = new Map([['482913', { device_id: 'd_counter1', token: 'tok-1' }]]);
  failures = 0;
  pushes: WireEvent[][] = [];
  failPull = 0;
  holdPush: Promise<void> | null = null;
  flag = new Set<string>();

  async pair(code: string): Promise<PairResponse> {
    const hit = this.codes.get(code);
    if (hit) {
      this.codes.delete(code);
      return hit;
    }
    this.failures += 1;
    return { error: this.failures >= 3 ? 'too_many_attempts' : 'invalid_code' };
  }

  failPush = 0;

  async push(_token: string, events: WireEvent[]): Promise<PushResponse> {
    await this.holdPush;
    if (this.failPush > 0) {
      this.failPush -= 1;
      throw new TransportError('network: offline');
    }
    this.pushes.push(events);
    return {
      server_time: new Date().toISOString(),
      results: events.map((e) => {
        const flagged = this.flag.has(e.type);
        return {
          id: e.id,
          status: flagged ? 'needs_review' : 'applied',
          reason: flagged ? 'price_mismatch' : null,
          detail: flagged ? { product_name: 'Tusker Lager', recorded_price_kes: 300, server_price_kes: 320 } : null,
          result: null,
          duplicate: false,
        };
      }),
    };
  }

  async pull(): Promise<PullResponse> {
    if (this.failPull > 0) {
      this.failPull -= 1;
      throw new TransportError('network: offline');
    }
    const seed = loadSeed();
    const data: PullData = {
      cursor: new Date().toISOString(),
      server_time: new Date().toISOString(),
      bar: [seed.bar], categories: seed.categories, people: seed.people, devices: seed.devices,
      products: seed.products, sizes: seed.sizes, kegs: seed.kegs, orders: seed.orders, lines: seed.lines,
      payments: seed.payments, approvals: [], shifts: seed.shifts,
    } as unknown as PullData;
    return data;
  }
}

let server: FakeServer;

beforeEach(() => {
  db = new KauntaDB(`kaunta-syncui-${++n}`);
  server = new FakeServer();
});
afterEach(() => db.delete());

const renderApp = (path = '/counter/login') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App db={db} transport={server} />
    </MemoryRouter>,
  );

const type = async (code: string) => {
  for (const digit of code) await user.click(screen.getByRole('button', { name: digit }));
};

describe('pairing a phone (R-DEV-1)', () => {
  it('asks for a code on a new phone, and starts with no sample data', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Connect this phone' })).toBeInTheDocument();
    expect(screen.getByText(/Ask an admin for a 6-digit pairing code/)).toBeInTheDocument();
    expect(await db.products.count()).toBe(0);
  });

  it('says so when a code is wrong, and stops after too many', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Connect this phone' });
    await type('111111');
    expect(await screen.findByText('That code didn’t work. Check it, or ask for a new one.')).toBeInTheDocument();
    await type('222222');
    await type('333333');
    expect(await screen.findByText('Too many wrong codes. Wait 10 minutes and try again.')).toBeInTheDocument();
  });

  it('with the right code, stores the token, pulls everything, and opens the staff list', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Connect this phone' });
    await type('482913');
    expect(await screen.findByRole('heading', { name: 'Who is at the counter?' })).toBeInTheDocument();
    expect(await screen.findByText('Counter 1 · shared device')).toBeInTheDocument();
    expect((await db.meta.get('device_token'))?.value).toBe('tok-1');
    expect(await db.products.count()).toBe(24);
  });

  it('if the first pull fails, it says so and can try again', async () => {
    server.failPull = 1;
    renderApp();
    await screen.findByRole('heading', { name: 'Connect this phone' });
    await type('482913');
    expect(await screen.findByText('Couldn’t reach the server. Check the internet and try again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Who is at the counter?' })).toBeInTheDocument();
  });
});

describe('a paired phone', () => {
  /** Paired and pulled, as after the Pair screen. */
  async function paired() {
    await db.meta.bulkPut([
      { key: 'device_id', value: 'd_counter1' },
      { key: 'device_token', value: 'tok-1' },
    ]);
  }

  it('sends what is recorded by itself, and the pill shows "Sending" while it goes', async () => {
    await paired();
    let release!: () => void;
    server.holdPush = new Promise((r) => (release = r));
    renderApp('/counter/sync');
    expect(await screen.findByText('Everything is sent')).toBeInTheDocument();

    await recordOrder(db, { person_id: 'p_wanjiku', device_id: 'd_counter1' }, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'soda_0', qty: 1 }] });
    expect(await screen.findByRole('button', { name: 'Sending 1…' })).toBeInTheDocument();
    release();
    expect(await screen.findByRole('button', { name: 'Synced' })).toBeInTheDocument();
    expect(server.pushes.flat().map((e) => e.type)).toEqual(['order_recorded']);
  });

  it('explains a price mismatch in the design’s words, and asks nothing of staff', async () => {
    await paired();
    server.flag.add('order_recorded');
    renderApp('/counter/sync');
    await screen.findByText('Everything is sent');
    await recordOrder(db, { person_id: 'p_wanjiku', device_id: 'd_counter1' }, { label: 'Table 6', server_id: 'p_wanjiku', items: [{ size_id: 'tusker_0', qty: 1 }] });

    expect(
      await screen.findByText('Tusker Lager was sold at KES 300 while offline, but an admin had changed the price to KES 320. The sale is kept as recorded.'),
    ).toBeInTheDocument();
    // In the summary at the top and on the item's card.
    expect(screen.getAllByText('An admin will decide. There’s nothing for you to do.').length).toBeGreaterThan(0);
    expect(document.querySelector('.c-review-card')).toHaveTextContent('nothing for you to do');
    expect(await screen.findByRole('button', { name: '1 needs admin' })).toBeInTheDocument();
  });

  it('after a failed send it offers Send now, which tries again at once', async () => {
    await paired();
    renderApp('/counter/sync');
    await screen.findByText('Everything is sent');
    server.failPush = 1;
    await recordOrder(db, { person_id: 'p_wanjiku', device_id: 'd_counter1' }, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'soda_0', qty: 1 }] });

    // The automatic attempt failed; the engine is waiting before it retries.
    expect(await screen.findByText('1 waiting to send')).toBeInTheDocument();
    const send = await screen.findByRole('button', { name: 'Send now' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await waitFor(async () => expect(await pendingEvents(db)).toHaveLength(0));
    expect(server.pushes.flat()).toHaveLength(1);
    expect(await screen.findByText('Everything is sent')).toBeInTheDocument();
  });
});
