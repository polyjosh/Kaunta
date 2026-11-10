import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { KauntaDB } from '../data/db';
import { DbProvider } from '../data/react';
import { seedDatabase } from '../data/seedDb';
import { I18nProvider } from '../lib/I18nProvider';
import type { Locale } from '../lib/i18n';
import { OrderDetailScreen } from './OrderDetailScreen';
import { OrdersScreen } from './OrdersScreen';
import { SessionProvider } from './Session';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();

beforeEach(async () => {
  // The counter snapshot in the designs: 22:20 Nairobi on business day 10 Nov. Only the clock is faked.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T19:20:00.000Z'));
  db = new KauntaDB(`kaunta-orders-${++n}`);
  await seedDatabase(db);
});
afterEach(async () => {
  vi.useRealTimers();
  await db.delete();
});

function renderAt(path: string, locale: Locale = 'en') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider initialLocale={locale}>
        <DbProvider db={db}>
          <SessionProvider initialPersonId="p_wanjiku">
            <Routes>
              <Route path="/counter/orders" element={<OrdersScreen />} />
              <Route path="/counter/orders/:id" element={<OrderDetailScreen />} />
              <Route path="/counter/sell" element={<p>sell screen</p>} />
            </Routes>
          </SessionProvider>
        </DbProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

const cards = () => screen.getAllByRole('link');

describe('3. Open orders', () => {
  it('sums what is still to collect and lists orders oldest first', async () => {
    renderAt('/counter/orders');
    expect(await screen.findByText('5 open · still to collect')).toBeInTheDocument();
    expect(screen.getByText('KES 6,480')).toBeInTheDocument();
    expect(cards().map((c) => within(c).getByRole('strong').textContent)).toEqual([
      'Mzee in blue',
      'Table 2',
      'Table 9',
      'Table 4',
      'Counter',
    ]);
  });

  it('shows number, server, items and time open on each card', async () => {
    renderAt('/counter/orders');
    await screen.findByText('5 open · still to collect');
    const [mzee, , table9, table4, counter] = cards();
    expect(mzee).toHaveTextContent('KES 2,300');
    expect(mzee).toHaveTextContent('#041 · Akinyi · 6 items');
    expect(table4).toHaveTextContent('#047 · Me · 5 items');
    expect(table4).toHaveTextContent('12 min');
    expect(counter).toHaveTextContent('#048 · Me · 2 items');
    expect(counter).toHaveTextContent('3 min');
    // Part paid: amount left, progress bar, paid-of line.
    expect(table9).toHaveTextContent('KES 850 left');
    expect(table9).toHaveTextContent('#044 · Kiprop · KES 400 of 1,250 paid');
    expect(table9).toHaveTextContent('22 min · part paid');
    expect(table9!.querySelector('.c-progress > span')).toHaveStyle({ width: '32%' });
  });

  it('R-ORD-1 marks orders open over 30 minutes with a yellow card and filled chip, never red', async () => {
    renderAt('/counter/orders');
    await screen.findByText('5 open · still to collect');
    const [mzee, table2, table9] = cards();
    expect(mzee).toHaveClass('is-old');
    expect(mzee).toHaveTextContent('46 min · open long');
    expect(table2).toHaveTextContent('38 min · open long');
    expect(table9).not.toHaveClass('is-old');
    expect(document.querySelector('[class*="error"]')).toBeNull();
  });

  it('ages live: an order crosses 30 minutes without a reload', async () => {
    // Fake the screen's ticking clock too (the database keeps real timers).
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-10T19:28:40.000Z')); // 22:28 — Table 9 (21:58) is exactly 30 min old
    renderAt('/counter/orders');
    await screen.findByText('Over 30 min · 2');
    await act(() => vi.advanceTimersByTimeAsync(60_000)); // 22:29:40 → 31 min
    expect(await screen.findByText('Over 30 min · 3')).toBeInTheDocument();
  });

  it('filters by All, Mine and Over 30 min, with counts', async () => {
    renderAt('/counter/orders');
    await user.click(await screen.findByRole('button', { name: 'Mine · 3' })); // served or recorded by me
    expect(cards().map((c) => within(c).getByRole('strong').textContent)).toEqual(['Table 9', 'Table 4', 'Counter']);
    await user.click(screen.getByRole('button', { name: 'Over 30 min · 2' }));
    expect(cards()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'All · 5' }));
    expect(cards()).toHaveLength(5);
  });

  it('shows the empty state when everything is paid', async () => {
    await db.orders.toCollection().modify({ status: 'paid' });
    renderAt('/counter/orders');
    expect(await screen.findByText('No open orders')).toBeInTheDocument();
    expect(screen.getByText(/Everything is paid or closed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Sell' }));
    expect(screen.getByText('sell screen')).toBeInTheDocument();
  });

  it('opens the order when a card is tapped', async () => {
    renderAt('/counter/orders');
    await user.click((await screen.findAllByRole('link'))[2]!);
    expect(await screen.findByRole('heading', { name: 'Table 9 #044' })).toBeInTheDocument();
  });

  it('reads in Kiswahili', async () => {
    renderAt('/counter/orders', 'sw');
    expect(await screen.findByText('5 wazi · bado kukusanywa')).toBeInTheDocument();
    expect(screen.getByText('Meza 9')).toBeInTheDocument();
    expect(screen.getByText('dak 46 · muda mrefu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Oda mpya' })).toBeInTheDocument();
  });
});

describe('4. Order detail and payment', () => {
  const open = async (id: string) => {
    renderAt(`/counter/orders/${id}`);
    await screen.findByText('Still to pay');
  };
  const pad = (key: string) => user.click(within(document.querySelector('.c-numpad') as HTMLElement).getByRole('button', { name: key }));

  it('shows who served and recorded, what is due, the lines and the payments', async () => {
    await open('o_044');
    expect(screen.getByRole('heading', { name: 'Table 9 #044' })).toBeInTheDocument();
    expect(screen.getByText('Open 22 min · since 21:58')).toBeInTheDocument();
    expect(screen.getByText('Server: Kiprop')).toBeInTheDocument();
    expect(screen.getByText('Recorded by Wanjiku')).toBeInTheDocument();
    expect(screen.getByText('KES 850')).toBeInTheDocument();
    expect(screen.getByText('KES 400 of 1,250 paid')).toBeInTheDocument();
    expect(screen.getByText('Part paid')).toBeInTheDocument();
    expect(screen.getByText('Items · 6')).toBeInTheDocument();
    expect(screen.getByText('Tusker Lager 500ml')).toBeInTheDocument();
    expect(screen.getByText('KES 300 each · 21:58 Wanjiku')).toBeInTheDocument();
    expect(screen.getByText('KES 350 · 21:58 Wanjiku')).toBeInTheDocument();
    expect(screen.getByText('Cash · 22:05 · Wanjiku')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm payment · KES 850' })).toBeInTheDocument();
  });

  it('full payment by M-Pesa with a code: the order leaves Open orders and a toast confirms', async () => {
    await open('o_044');
    await user.click(screen.getByRole('button', { name: 'Confirm payment · KES 850' }));
    const sheet = screen.getByRole('dialog', { name: 'Confirm payment' });
    expect(within(sheet).getByRole('button', { name: /All of it/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sheet).getByRole('radio', { name: 'M-Pesa' })).toBeChecked();
    await user.type(within(sheet).getByRole('textbox', { name: /Last 4 of the M-Pesa code/ }), 'qk7p');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm KES 850 received' }));

    expect(await screen.findByText('#044 paid in full by M-Pesa')).toBeInTheDocument();
    expect(screen.getByText('4 open · still to collect')).toBeInTheDocument();
    expect(await db.orders.get('o_044')).toMatchObject({ status: 'paid' });
    const mpesa = (await db.payments.where('order_id').equals('o_044').toArray()).find((p) => p.method === 'mpesa');
    expect(mpesa).toMatchObject({ amount_kes: 850, mpesa_ref_last4: 'QK7P', recorded_by: 'p_wanjiku', device_id: 'd_counter1' });
  });

  it('part payment in cash, entered on the keypad, updates the bar and what is due', async () => {
    await open('o_047');
    await user.click(screen.getByRole('button', { name: 'Confirm payment · KES 1,250' }));
    const sheet = screen.getByRole('dialog', { name: 'Confirm payment' });
    await user.click(within(sheet).getByRole('radio', { name: 'Cash' }));
    await user.click(within(sheet).getByRole('button', { name: /Part of it/ }));
    expect(within(sheet).getByRole('button', { name: 'Confirm KES 0 received' })).toBeDisabled();
    await pad('3');
    await pad('00');
    expect(within(sheet).queryByRole('textbox')).toBeNull(); // no M-Pesa code for cash
    await user.click(within(sheet).getByRole('button', { name: 'Confirm KES 300 received' }));

    expect(await screen.findByText('KES 300 received by cash · KES 950 left')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('KES 300 of 1,250 paid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm payment · KES 950' })).toBeInTheDocument();
    expect((await db.orders.get('o_047'))?.status).toBe('open');
  });

  it('never accepts more than is due: the keypad stops at the amount due', async () => {
    await open('o_048'); // KES 600 due
    await user.click(screen.getByRole('button', { name: 'Confirm payment · KES 600' }));
    await user.click(screen.getByRole('button', { name: /Part of it/ }));
    for (const key of ['9', '9', '9']) await pad(key);
    expect(screen.getByRole('button', { name: 'Confirm KES 600 received' })).toBeEnabled();
  });

  it('split payment records cash and M-Pesa together; the two add up to the amount received', async () => {
    await open('o_048');
    await user.click(screen.getByRole('button', { name: 'Confirm payment · KES 600' }));
    const sheet = screen.getByRole('dialog', { name: 'Confirm payment' });
    await user.click(within(sheet).getByRole('radio', { name: 'Split' }));
    expect(within(sheet).getByRole('button', { name: 'Confirm KES 600 received' })).toBeDisabled(); // no cash amount yet
    await pad('2');
    await pad('00');
    expect(sheet).toHaveTextContent('CashKES 200');
    expect(sheet).toHaveTextContent('M-PesaKES 400');
    await user.click(within(sheet).getByRole('button', { name: 'Confirm KES 600 received' }));

    expect(await screen.findByText('#048 paid in full by cash + M-Pesa')).toBeInTheDocument();
    const rows = await db.payments.where('order_id').equals('o_048').toArray();
    expect(rows.map((p) => [p.method, p.amount_kes]).sort()).toEqual([
      ['cash', 200],
      ['mpesa', 400],
    ]);
    expect(rows[0]?.created_at).toBe(rows[1]?.created_at);
  });

  it('R-ORD-4 will not confirm with a half-typed M-Pesa code', async () => {
    await open('o_048');
    await user.click(screen.getByRole('button', { name: 'Confirm payment · KES 600' }));
    const code = screen.getByRole('textbox', { name: /Last 4 of the M-Pesa code/ });
    await user.type(code, 'q-k7');
    expect(code).toHaveValue('QK7'); // only letters and digits, uppercase
    expect(screen.getByRole('button', { name: 'Confirm KES 600 received' })).toBeDisabled();
    await user.type(code, 'p');
    expect(screen.getByRole('button', { name: 'Confirm KES 600 received' })).toBeEnabled();
  });

  it('R-ORD-5 split bill evenly: shows each share, and a share becomes a part payment', async () => {
    await open('o_044'); // KES 850 left
    await user.click(screen.getByRole('button', { name: 'Split bill' }));
    const split = screen.getByRole('dialog', { name: 'Split bill' });
    expect(within(split).getByText('Split what’s left, KES 850, evenly between:')).toBeInTheDocument();
    expect(within(split).getByRole('button', { name: /2 people/ })).toHaveTextContent('KES 425 each');
    expect(within(split).getByRole('button', { name: /3 people/ })).toHaveTextContent('KES 284 each');
    expect(within(split).getByRole('button', { name: /4 people/ })).toHaveTextContent('KES 213 each');

    await user.click(within(split).getByRole('button', { name: /2 people/ }));
    const pay = screen.getByRole('dialog', { name: 'Confirm payment' });
    await user.click(within(pay).getByRole('radio', { name: 'Cash' }));
    await user.click(within(pay).getByRole('button', { name: 'Confirm KES 425 received' }));
    expect(await screen.findByText('KES 425 received by cash · KES 425 left')).toBeInTheDocument();
  });

  it('a paid order shows as paid with nothing left to confirm', async () => {
    await db.orders.update('o_048', { status: 'paid' });
    await db.payments.add({
      id: 'x', order_id: 'o_048', method: 'cash', amount_kes: 600, mpesa_ref_last4: null,
      recorded_by: 'p_wanjiku', device_id: 'd_counter1', created_at: '2026-11-10T19:19:00.000Z', synced_at: null,
    });
    await open('o_048');
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm payment/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Split bill' })).toBeNull();
  });
});
