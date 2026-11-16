import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App } from '../App';
import { KauntaDB } from '../data/db';
import { pendingEvents } from '../data/outbox';
import { DbProvider } from '../data/react';
import { seedDatabase } from '../data/seedDb';
import { orderTotal } from '../domain/orders';
import { I18nProvider } from '../lib/I18nProvider';
import type { Locale } from '../lib/i18n';
import { displayLabel, labelForTable, matchesSearch } from './labels';
import { SellScreen } from './SellScreen';
import { SessionProvider } from './Session';

let db: KauntaDB;
let n = 0;

/** The counter screens' snapshot (seed `_note`): 22:20 on the sample evening, so the next order is #049 on any real date. */
const COUNTER_NOW = '2026-11-10T19:20:00.000Z';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(COUNTER_NOW));
  db = new KauntaDB(`kaunta-ui-${++n}`);
  await seedDatabase(db);
});
afterEach(async () => {
  vi.useRealTimers();
  await db.delete();
});

const user = userEvent.setup();

/** Counts every tap on a button, to hold the 2-tap / 3-tap promise to account. */
function countTaps() {
  let taps = 0;
  const onClick = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('button')) taps += 1;
  };
  document.addEventListener('click', onClick, true);
  return { get count() { return taps; }, stop: () => document.removeEventListener('click', onClick, true) };
}

function renderApp(path = '/counter/login') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App db={db} />
    </MemoryRouter>,
  );
}

function renderSell(locale: Locale = 'en') {
  return render(
    <MemoryRouter initialEntries={['/counter/sell']}>
      <I18nProvider initialLocale={locale}>
        <DbProvider db={db}>
          <SessionProvider initialPersonId="p_wanjiku">
            <Routes>
              <Route path="/counter/sell" element={<SellScreen />} />
              <Route path="*" element={<p>elsewhere</p>} />
            </Routes>
          </SessionProvider>
        </DbProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

const typePin = async (pin: string) => {
  for (const digit of pin) await user.click(screen.getByRole('button', { name: digit }));
};

describe('1. PIN login', () => {
  it('lists everyone who logs in here (staff, then the owner and managers), and nobody else', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Who is at the counter?' })).toBeInTheDocument();
    expect(await screen.findByText('Baraka Pub')).toBeInTheDocument();
    expect(await screen.findByText('Counter 1 · shared device')).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Wanjiku' });
    for (const name of ['Wanjiku', 'Otieno', 'Akinyi', 'Kiprop', 'Mwangi']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    // The owner (password) and the manager (PIN) can sell too; they come last, marked.
    const names = screen.getAllByRole('button').filter((b) => b.classList.contains('c-staff-tile')).map((b) => b.textContent);
    expect(names.slice(-2)).toEqual(['CChebetManager', 'NNjeriOwner']);
    expect(screen.queryByRole('button', { name: /Juma/ })).toBeNull(); // server only
  });

  it('submits on the 4th digit and opens Sell for the right PIN', async () => {
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Wanjiku' }));
    expect(screen.getByText('Enter your 4-digit PIN')).toBeInTheDocument();
    await typePin('2580');
    expect(await screen.findByRole('button', { name: 'Record (pay later)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Switch user · Wanjiku/ })).toBeInTheDocument();
  });

  it('clears the dots and says how many tries are left after a wrong PIN', async () => {
    const { container } = renderApp();
    await user.click(await screen.findByRole('button', { name: 'Wanjiku' }));
    await typePin('1111');
    expect(await screen.findByText('Wrong PIN · 4 tries left')).toBeInTheDocument();
    expect(container.querySelectorAll('.c-pin-dots .is-filled')).toHaveLength(0);

    await typePin('12');
    expect(container.querySelectorAll('.c-pin-dots .is-filled')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Delete last digit' }));
    expect(container.querySelectorAll('.c-pin-dots .is-filled')).toHaveLength(1);
  });

  it('locks after the 5th wrong PIN and shows the countdown', async () => {
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Wanjiku' }));
    for (const left of [4, 3, 2]) {
      await typePin('0000');
      await screen.findByText(`Wrong PIN · ${left} tries left`);
    }
    await typePin('0000');
    await screen.findByText('Wrong PIN · 1 try left');
    await typePin('0000');

    expect(await screen.findByText('Locked · 5 wrong PINs')).toBeInTheDocument();
    expect(screen.getByRole('timer').textContent).toMatch(/^[45]:\d\d$/);
    expect(screen.getByText(/Wanjiku’s PIN was wrong 5 times/)).toBeInTheDocument();
    expect((await db.people.get('p_wanjiku'))?.pin_locked_until).not.toBeNull();
  });

  it('shows a person locked elsewhere as locked here, and lets you choose another name', async () => {
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Otieno' }));
    expect(screen.getByText('Locked · 5 wrong PINs')).toBeInTheDocument();
    expect(screen.queryByText('Enter your 4-digit PIN')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Choose another name' }));
    expect(screen.getByRole('heading', { name: 'Who is at the counter?' })).toBeInTheDocument();
  });

  it('sends anyone not logged in back to the names', async () => {
    renderApp('/counter/sell');
    expect(await screen.findByRole('heading', { name: 'Who is at the counter?' })).toBeInTheDocument();
  });
});

describe('2. Sell', () => {
  it('records a pay-later sale in 2 taps', async () => {
    renderSell();
    const tile = await screen.findByRole('button', { name: 'Tusker Lager' });
    const taps = countTaps();
    await user.click(tile);
    await user.click(screen.getByRole('button', { name: 'Record (pay later)' }));
    taps.stop();

    expect(await screen.findByText('Order #049 recorded · No table · pay later')).toBeInTheDocument();
    expect(taps.count).toBe(2);

    const order = (await db.orders.where('short_no').equals('#049').first().catch(() => undefined)) ??
      (await db.orders.toArray()).find((o) => o.short_no === '#049');
    expect(order).toMatchObject({ status: 'open', label: '', server_id: 'p_wanjiku', recorded_by: 'p_wanjiku', device_id: 'd_counter1' });
    expect(orderTotal(await db.lines.where('order_id').equals(order!.id).toArray())).toBe(300);
    expect(await pendingEvents(db)).toHaveLength(1);
  });

  it('records a paid sale in 3 taps', async () => {
    renderSell();
    const tile = await screen.findByRole('button', { name: 'Guinness' });
    const taps = countTaps();
    await user.click(tile);
    await user.click(screen.getByRole('button', { name: 'Record & paid' }));
    await user.click(screen.getByRole('button', { name: 'M-Pesa' }));
    taps.stop();

    expect(await screen.findByText('Order #049 recorded · paid by M-Pesa')).toBeInTheDocument();
    expect(taps.count).toBe(3);
    const order = (await db.orders.toArray()).find((o) => o.short_no === '#049')!;
    expect(order.status).toBe('paid');
    expect(await db.payments.where('order_id').equals(order.id).toArray()).toMatchObject([{ method: 'mpesa', amount_kes: 330 }]);
  });

  it('starts with an empty tray: buttons off and a hint', async () => {
    renderSell();
    expect(await screen.findByText('Tap a drink to start an order')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record (pay later)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Record & paid' })).toBeDisabled();
    expect(screen.getByText('KES 0')).toBeInTheDocument();
  });

  it('shows the tile states: price and size, several sizes, low stock, out of stock', async () => {
    renderSell();
    const tusker = await screen.findByRole('button', { name: 'Tusker Lager' });
    expect(tusker).toHaveTextContent('KES 300');
    expect(tusker).toHaveTextContent('500ml');
    expect(screen.getByRole('button', { name: /Tusker Cider/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Tusker Cider/ })).toHaveTextContent('Out of stock');
    // Pilsner is at −4: still sellable (R-SELL-2) and never shown as "−4 left".
    expect(screen.getByRole('button', { name: 'Pilsner' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Pilsner' })).not.toHaveTextContent('left');

    await user.click(screen.getByRole('tab', { name: 'Spirits' }));
    const cane = screen.getByRole('button', { name: 'Kenya Cane' });
    expect(cane).toHaveTextContent('5 sizes');
    expect(cane).toHaveTextContent('from KES 80');

    await user.click(screen.getByRole('tab', { name: 'Soft drinks' }));
    expect(screen.getByRole('button', { name: 'Tonic water' })).toHaveTextContent('4 left');
  });

  it('opens the size picker for a product with several sizes; picking adds one and closes it', async () => {
    renderSell();
    await user.click(await screen.findByRole('tab', { name: 'Spirits' }));
    await user.click(screen.getByRole('button', { name: 'Kenya Cane' }));

    const picker = screen.getByRole('dialog', { name: 'Kenya Cane' });
    expect(within(picker).getByText('Pick a size')).toBeInTheDocument();
    expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['TotKES 80', '250mlKES 350', '350mlKES 450', '750mlKES 900', '1 LitreKES 1,200']),
    );
    await user.click(within(picker).getByRole('button', { name: /350ml/ }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Kenya Cane, 1 in order' })).toBeInTheDocument();
    expect(screen.getByText('Kenya Cane 350ml')).toBeInTheDocument();
    expect(screen.getByText('KES 450')).toBeInTheDocument();
  });

  it('adds up the tray and lets the order be edited or cleared', async () => {
    renderSell();
    const tusker = await screen.findByRole('button', { name: 'Tusker Lager' });
    await user.click(tusker);
    await user.click(screen.getByRole('button', { name: 'Tusker Lager, 1 in order' }));
    await user.click(screen.getByRole('button', { name: 'White Cap' }));
    expect(screen.getByText('3 items')).toBeInTheDocument();
    expect(screen.getByText('Tusker Lager ×2 · White Cap')).toBeInTheDocument();
    expect(screen.getByText('KES 900')).toBeInTheDocument();

    await user.click(screen.getByText('3 items'));
    const sheet = screen.getByRole('dialog', { name: 'This order · #049' });
    expect(within(sheet).getByText('500ml · KES 300 each · KES 600')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Remove one: Tusker Lager' }));
    await user.click(within(sheet).getByRole('button', { name: 'Add one: White Cap' }));
    expect(within(sheet).getByText('500ml · KES 300 each · KES 300')).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Clear this order' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Tap a drink to start an order')).toBeInTheDocument();
  });

  it('searches every category by English or Kiswahili name', async () => {
    renderSell();
    const search = await screen.findByRole('searchbox', { name: 'Search drinks or food' });
    await user.type(search, 'maji');
    expect(screen.getByText('Results for “maji”')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Water' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tusker Lager' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Beer' })).toHaveAttribute('aria-selected', 'false');

    await user.clear(search);
    await user.type(search, 'choma');
    expect(screen.getByRole('button', { name: 'Nyama choma' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kuku choma' })).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'whisky');
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('button', { name: 'Tusker Lager' })).toBeInTheDocument();
  });

  it('keeps the chosen server for the next order and resets the table (R-SELL-3)', async () => {
    renderSell();
    await user.click(await screen.findByRole('button', { name: /Server: Me/ }));
    const servers = screen.getByRole('dialog', { name: 'Who is serving?' });
    expect(within(servers).getByRole('button', { name: 'Me (Wanjiku)' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(servers).getByRole('button', { name: 'Juma' })).toBeInTheDocument(); // server without a login
    await user.click(within(servers).getByRole('button', { name: 'Kiprop' }));

    await user.click(screen.getByRole('button', { name: 'No table' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Table or customer' })).getByRole('button', { name: '4' }));
    expect(screen.getByRole('button', { name: 'Table 4' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Record (pay later)' }));
    expect(await screen.findByText('Order #049 recorded · Table 4 · pay later')).toBeInTheDocument();

    const order = (await db.orders.toArray()).find((o) => o.short_no === '#049')!;
    expect(order).toMatchObject({ label: 'Table 4', server_id: 'p_kiprop', recorded_by: 'p_wanjiku' });
    expect(screen.getByRole('button', { name: /Server: Kiprop/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No table' })).toBeInTheDocument();
    expect(screen.getByText('Tap a drink to start an order')).toBeInTheDocument();
  });

  it('counts open orders on the badge, live', async () => {
    renderSell();
    expect(await screen.findByRole('button', { name: 'Open orders · 5' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Record (pay later)' }));
    expect(await screen.findByRole('button', { name: 'Open orders · 6' })).toBeInTheDocument();
  });

  it('shows the sync pill counting what is waiting', async () => {
    renderSell();
    expect(await screen.findByRole('button', { name: 'Synced' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Record (pay later)' }));
    expect(await screen.findByRole('button', { name: '1 waiting' })).toBeInTheDocument();
  });

  it('works in Kiswahili with the same flow', async () => {
    renderSell('sw');
    expect(await screen.findByRole('tab', { name: 'Bia' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /Tusker Cider/ })).toHaveTextContent('Kimeisha');
    await user.click(screen.getByRole('tab', { name: 'Soda na maji' }));
    await user.click(screen.getByRole('button', { name: 'Maji' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Maji' })).getByRole('button', { name: /Lita 1/ }));
    await user.click(screen.getByRole('button', { name: 'Rekodi (lipa baadaye)' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Oda #049 imerekodiwa · Bila meza/));
  });
});

describe('labels', () => {
  const t = ((key: string, params?: Record<string, string | number>) =>
    key === 'sell.table' ? `Meza ${params?.n}` : key) as never;

  it('stores tables in one canonical form and shows them in the current language', () => {
    expect(labelForTable('4')).toBe('Table 4');
    expect(labelForTable('counter')).toBe('Counter');
    expect(labelForTable(null)).toBe('');
    expect(displayLabel('Table 4', t)).toBe('Meza 4');
    expect(displayLabel('Counter', t)).toBe('sell.counter');
    expect(displayLabel('', t)).toBe('sell.noTable');
    expect(displayLabel('Mzee in blue', t)).toBe('Mzee in blue');
  });

  it('matches search on either name, ignoring case and spaces', () => {
    expect(matchesSearch({ name: 'Water', name_sw: 'Maji' }, ' MAJ ')).toBe(true);
    expect(matchesSearch({ name: 'Water', name_sw: 'Maji' }, 'wat')).toBe(true);
    expect(matchesSearch({ name: 'Water', name_sw: null }, 'maji')).toBe(false);
  });
});
