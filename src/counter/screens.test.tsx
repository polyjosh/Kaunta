import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { recordOrder, recordPayment } from '../data/commands';
import { KauntaDB } from '../data/db';
import { markNeedsReview, pendingEvents } from '../data/outbox';
import type { RecordContext } from '../data/outbox';
import { DbProvider } from '../data/react';
import { seedDatabase } from '../data/seedDb';
import { handOverOrder } from '../data/shifts';
import { voidLines } from '../data/voids';
import { I18nProvider } from '../lib/I18nProvider';
import type { Locale } from '../lib/i18n';
import { OrderDetailScreen } from './OrderDetailScreen';
import { OrdersScreen } from './OrdersScreen';
import { SellScreen } from './SellScreen';
import { SessionProvider } from './Session';
import { ShiftScreen } from './ShiftScreen';
import { SyncScreen } from './SyncScreen';
import { VoidScreen } from './VoidScreen';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();
const NOW = Date.parse('2026-11-10T19:20:00.000Z'); // 22:20 Nairobi, the counter snapshot
const ago = (seconds: number, person = 'p_wanjiku'): RecordContext => ({
  person_id: person,
  device_id: 'd_counter1',
  now: () => new Date(NOW - seconds * 1000),
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  db = new KauntaDB(`kaunta-screens-${++n}`);
  await seedDatabase(db);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await db.delete();
});

function renderAt(path: string, locale: Locale = 'en') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider initialLocale={locale}>
        <DbProvider db={db}>
          <SessionProvider initialPersonId="p_wanjiku">
            <Routes>
              <Route path="/counter/sell" element={<SellScreen />} />
              <Route path="/counter/orders" element={<OrdersScreen />} />
              <Route path="/counter/orders/:id" element={<OrderDetailScreen />} />
              <Route path="/counter/orders/:id/void" element={<VoidScreen />} />
              <Route path="/counter/shift/close" element={<ShiftScreen />} />
              <Route path="/counter/sync" element={<SyncScreen />} />
              <Route path="/counter/login" element={<p>login screen</p>} />
            </Routes>
          </SessionProvider>
        </DbProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

/** Wanjiku records 2 Tusker for Table 4, `seconds` before now. */
const freshOrder = (seconds: number) =>
  recordOrder(db, ago(seconds), { label: 'Table 4', server_id: 'p_wanjiku', items: [{ size_id: 'tusker_0', qty: 2 }] });

describe('5. Void request', () => {
  it('inside the window: blue banner with a live countdown, and you can void it yourself', async () => {
    const order = await freshOrder(48);
    renderAt(`/counter/orders/${order.id}/void`);

    expect(await screen.findByRole('heading', { name: `Void · Table 4 ${order.short_no}` })).toBeInTheDocument();
    expect(screen.getByText('You can void this yourself')).toBeInTheDocument();
    expect(screen.getByText('Recorded 0:48 ago. The self-void window closes in 1:12.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pick a reason' })).toBeDisabled();

    const what = screen.getByRole('radiogroup', { name: 'What to void' });
    expect(within(what).getByRole('radio', { name: /Tusker Lager 500ml ×1/ })).toHaveTextContent('KES 300');
    expect(within(what).getByRole('radio', { name: /Whole order/ })).toHaveTextContent('2 itemsKES 600');
    await user.click(within(what).getByRole('radio', { name: /Tusker Lager 500ml ×1/ }));
    await user.click(screen.getByRole('radio', { name: 'Entered by mistake' }));

    const button = screen.getByRole('button', { name: 'Void Tusker Lager' });
    expect(button).toHaveClass('is-void'); // red outline, never filled
    await user.click(button);

    expect(await screen.findByText(`Voided · Tusker Lager removed from Table 4 ${order.short_no}`)).toBeInTheDocument();
    expect(await screen.findByText('Items · 1')).toBeInTheDocument();
    expect(screen.getByText('Voided')).toBeInTheDocument();
    expect(await db.approvals.count()).toBe(0);
  });

  it('lists the reasons with their notes', async () => {
    const order = await freshOrder(10);
    renderAt(`/counter/orders/${order.id}/void`);
    const why = await screen.findByRole('radiogroup', { name: 'Why?' });
    expect(within(why).getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Entered by mistake',
      'Customer changed their mindOnly if the drink wasn’t opened',
      'Wrong size or product',
      'Spilled or brokenRecorded as a write-off: the stock is gone',
      'Something elseAlways goes to an admin',
    ]);
    expect(screen.getByText(/Recorded by Wanjiku on Counter 1\. Every void goes in the audit log/)).toBeInTheDocument();
  });

  it('spilled or "something else" go to an admin even inside the window', async () => {
    const order = await freshOrder(10);
    renderAt(`/counter/orders/${order.id}/void`);
    await user.click(await screen.findByRole('radio', { name: /Whole order/ }));
    await user.click(screen.getByRole('radio', { name: /Spilled or broken/ }));
    expect(screen.getByRole('button', { name: 'Send to admin for approval' })).toHaveClass('is-admin');
    await user.click(screen.getByRole('radio', { name: /Something else/ }));
    expect(screen.getByRole('button', { name: 'Send to admin for approval' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Wrong size or product' }));
    expect(screen.getByRole('button', { name: `Void whole order ${order.short_no}` })).toBeInTheDocument();
  });

  it('past the window: yellow banner, the request goes to an admin and the item stays on the order', async () => {
    const guinness = (await db.lines.where('order_id').equals('o_039').toArray()).find((l) => l.size_id === 'guinness_0')!;
    renderAt(`/counter/orders/o_039/void?line=${guinness.id}`);

    expect(await screen.findByText('An admin needs to approve this')).toBeInTheDocument();
    expect(screen.getByText(/Recorded 38 min ago, so it’s past the 5-minute self-void window/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Guinness 500ml ×1/ })).toBeChecked(); // came from that line's menu
    await user.click(screen.getByRole('radio', { name: /Customer changed their mind/ }));
    await user.click(screen.getByRole('button', { name: 'Send to admin for approval' }));

    expect(await screen.findByText('Sent to admin · waiting for approval')).toBeInTheDocument();
    expect(await screen.findByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('Items · 4')).toBeInTheDocument(); // still on the order
    expect(screen.getByRole('button', { name: 'Confirm payment · KES 1,480' })).toBeInTheDocument();
    expect(await db.approvals.toArray()).toMatchObject([{ kind: 'void', amount_kes: 330, reason_code: 'changed', status: 'waiting' }]);
  });

  it('switches to the approval variant when the countdown reaches zero, keeping the chosen reason', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date(NOW));
    const order = await freshOrder(115); // 5 seconds of window left
    renderAt(`/counter/orders/${order.id}/void`);

    expect(await screen.findByText(/closes in 0:05/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Whole order/ }));
    await user.click(screen.getByRole('radio', { name: 'Entered by mistake' }));
    expect(screen.getByRole('button', { name: /^Void whole order/ })).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByText(/closes in 0:02/)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3000));

    expect(screen.getByText('An admin needs to approve this')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Entered by mistake' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Send to admin for approval' })).toBeInTheDocument();
  });

  it('voiding the whole order yourself takes you back to Open orders without it', async () => {
    const order = await freshOrder(30);
    renderAt(`/counter/orders/${order.id}/void`);
    await user.click(await screen.findByRole('radio', { name: /Whole order/ }));
    await user.click(screen.getByRole('radio', { name: 'Entered by mistake' }));
    await user.click(screen.getByRole('button', { name: /^Void whole order/ }));
    expect(await screen.findByText('5 open · still to collect')).toBeInTheDocument();
    expect((await db.orders.get(order.id))?.status).toBe('voided');
  });

  it('is reached from a line’s menu and from the void link on the order', async () => {
    renderAt('/counter/orders/o_048');
    await user.click(await screen.findByRole('button', { name: 'Options for Tusker Lager 500ml' }));
    const menu = screen.getByRole('dialog', { name: 'Tusker Lager 500ml' });
    await user.click(within(menu).getByRole('button', { name: 'Void this item' }));
    expect(await screen.findByRole('heading', { name: 'Void · Counter #048' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Tusker Lager 500ml ×1/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Void an item or this order' }));
    expect(await screen.findByRole('heading', { name: 'Void · Counter #048' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { checked: true })).toBeNull(); // nothing preselected
  });

  it('Undo on the Sell toast voids the order just recorded', async () => {
    renderAt('/counter/sell');
    await user.click(await screen.findByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Record (pay later)' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Order #049 removed')).toBeInTheDocument();
    expect((await db.orders.toArray()).find((o) => o.short_no === '#049')?.status).toBe('voided');
    expect((await db.products.get('tusker'))?.stock_qty).toBe(24);
  });
});

describe('6. Shift close', () => {
  const settleAll = async () => {
    await recordPayment(db, ago(0), 'o_048', [{ method: 'mpesa', amount_kes: 600 }]);
    await handOverOrder(db, ago(0), 'o_047');
    await voidLines(db, ago(0), { order_id: 'o_044', items: [], whole_order: true, reason: 'other' });
  };

  it('is blocked while orders are open: each one can be paid, voided or handed over', async () => {
    renderAt('/counter/shift/close');
    expect(await screen.findByText('3 orders are still open')).toBeInTheDocument();
    expect(screen.getByText('Wanjiku · Counter 1 · 18:00 – 22:20')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Count cash · settle 3 orders first' })).toBeDisabled();

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent('Table 9 #044KES 850 left');
    expect(cards[0]).toHaveTextContent('Kiprop · KES 400 of 1,250 paid');
    expect(cards[1]).toHaveTextContent('Table 4 #047KES 1,250');
    expect(cards[1]).toHaveTextContent('Wanjiku · 5 items · 12 min');
    for (const card of cards) {
      for (const name of ['Pay', 'Void', 'Hand over']) expect(within(card).getByRole('button', { name })).toBeInTheDocument();
    }

    await user.click(within(cards[2]!).getByRole('button', { name: 'Hand over' }));
    expect(await screen.findByText('2 orders are still open')).toBeInTheDocument();
    expect(await db.orders.get('o_048')).toMatchObject({ handover_pending: true });
  });

  it('Pay and Void on a card open that order', async () => {
    renderAt('/counter/shift/close');
    const [first] = await screen.findAllByRole('article');
    await user.click(within(first!).getByRole('button', { name: 'Void' }));
    expect(await screen.findByRole('heading', { name: 'Void · Table 9 #044' })).toBeInTheDocument();
  });

  it('once settled, shows the count: float + cash sales − expenses = expected', async () => {
    await settleAll();
    renderAt('/counter/shift/close');
    expect(await screen.findByText('Expected in the drawer')).toBeInTheDocument();
    const rows = [...document.querySelectorAll('.c-breakdown > div')].map((r) => r.textContent);
    expect(rows).toEqual([
      'Float at startKES 2,000',
      '+ Cash salesKES 11,950',
      '− Expenses from the drawer AddKES 1,200',
      'Expected in the drawerKES 12,750',
    ]);
    expect(screen.getByText(/M-Pesa this shift: KES 19,000 recorded/)).toBeInTheDocument(); // 18,400 + the 600 just taken
    expect(screen.getByRole('button', { name: 'Close shift & hand over cash' })).toBeDisabled(); // nothing counted yet
  });

  it('R-SHIFT-2 the result updates on every key press: Short, Matches, Over', async () => {
    await settleAll();
    renderAt('/counter/shift/close');
    await screen.findByText('Expected in the drawer');
    const result = () => document.querySelector('.c-result')!;
    const press = (key: string) => user.click(screen.getByRole('button', { name: key }));

    expect(result()).toHaveTextContent('ShortKES 12,750');
    for (const key of ['1', '2', '4', '5', '0']) await press(key);
    expect(document.querySelector('.c-amount-display')).toHaveTextContent('KES12,450');
    expect(result()).toHaveTextContent('ShortKES 300'); // in words, never "−300"
    expect(result()).toHaveAttribute('data-result', 'short');
    expect(result().textContent).not.toMatch(/[-−]/);

    await press('Delete last digit');
    await press('Delete last digit');
    await press('Delete last digit');
    for (const key of ['7', '5', '0']) await press(key);
    expect(result()).toHaveTextContent('MatchesKES 0');

    await press('Delete last digit');
    await press('Delete last digit');
    await press('Delete last digit');
    for (const key of ['9', '00']) await press(key);
    expect(result()).toHaveTextContent('OverKES 150');
    expect(result()).toHaveClass('k-tone-pending'); // blue, not an error
  });

  it('closing records the count and the result, and logs out', async () => {
    await settleAll();
    renderAt('/counter/shift/close');
    await screen.findByText('Expected in the drawer');
    for (const key of ['1', '2', '4', '5', '0']) await user.click(screen.getByRole('button', { name: key }));
    await user.click(screen.getByRole('button', { name: 'Close shift & hand over cash' }));

    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(await db.shifts.get('s_p_wanjiku')).toMatchObject({ counted_cash_kes: 12450, result_kes: -300 });
    expect((await db.shifts.get('s_p_wanjiku'))?.closed_at).not.toBeNull();
    expect((await pendingEvents(db)).at(-1)?.type).toBe('shift_closed');
  });

  it('is reached from the recorder’s menu on Sell', async () => {
    renderAt('/counter/sell');
    await user.click(await screen.findByRole('button', { name: /Switch user · Wanjiku/ }));
    await user.click(within(screen.getByRole('dialog', { name: 'Wanjiku' })).getByRole('button', { name: 'Close shift' }));
    expect(await screen.findByText('3 orders are still open')).toBeInTheDocument();
  });

  it('reads in Kiswahili', async () => {
    renderAt('/counter/shift/close', 'sw');
    expect(await screen.findByText('Oda 3 bado ziko wazi')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Kabidhi' })).toHaveLength(3);
  });
});

describe('7. Sync status', () => {
  const noRed = () => expect(document.querySelector('[class*="error"], .is-void')).toBeNull();

  it('says everything is sent when the queue is empty', async () => {
    renderAt('/counter/sync');
    expect(await screen.findByText('Everything is sent')).toBeInTheDocument();
    expect(screen.getByText('Last synced 22:20. Nothing is waiting.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Synced' })).toBeInTheDocument();
    noRed();
  });

  it('lists what is waiting, in order, with amount, time and who; the pill matches the count', async () => {
    const order = await freshOrder(0);
    await recordPayment(db, ago(0), 'o_044', [{ method: 'cash', amount_kes: 400 }]);
    await voidLines(db, ago(0), { order_id: 'o_039', items: [], whole_order: true, reason: 'other' });
    renderAt('/counter/sync');

    expect(await screen.findByText('3 waiting to send')).toBeInTheDocument();
    expect(screen.getByText(/Last synced 22:20\. These will send automatically/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Waiting to sync · 3' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '3 waiting' })).toBeInTheDocument();

    const rows = [...document.querySelectorAll('.c-sync-row')];
    expect(rows.map((r) => r.querySelector('strong')?.textContent)).toEqual([
      `Order ${order.short_no} · Table 4`,
      'Payment on #044 · Cash',
      'Void request on #039',
    ]);
    expect(rows[0]).toHaveTextContent('KES 600 · 22:20 · Wanjiku');
    expect(rows[1]).toHaveTextContent('KES 400 · 22:20 · Wanjiku');
    for (const row of rows) expect(row).toHaveTextContent('Waiting');
    expect(screen.getByText(/Nothing here is lost if the phone restarts/)).toBeInTheDocument();
    noRed();
  });

  it('offline is calm and grey: keep selling, everything is saved on this phone', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await freshOrder(0);
    await freshOrder(0);
    renderAt('/counter/sync');

    expect(await screen.findByText('Offline. Keep selling.')).toBeInTheDocument();
    expect(screen.getByText(/No internet since 22:20\. Everything is saved on this phone/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Saved on this phone · 2' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Offline · 2 saved' })).toBeInTheDocument();
    expect(document.querySelector('.c-sync-hero')).toHaveClass('k-tone-offline');
    for (const row of document.querySelectorAll('.c-sync-row')) expect(row).toHaveTextContent('Saved');
    noRed();
  });

  it('something an admin must review is yellow and asks nothing of staff', async () => {
    await freshOrder(0);
    const [entry] = await pendingEvents(db);
    await markNeedsReview(db, entry!.id, 'price_mismatch', new Date(NOW).toISOString());
    renderAt('/counter/sync');

    expect(await screen.findByText('Needs admin')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '1 needs admin' })).toBeInTheDocument();
    expect(document.querySelector('.c-sync-hero')).toHaveClass('k-tone-warning');
    expect(document.querySelector('.c-review-card')).toHaveTextContent(/Order #049 · Table 4/);
    expect(document.querySelector('.c-review-card')).toHaveTextContent('An admin will decide. There’s nothing for you to do.');
    noRed();
  });

  it('opens from the pill on any counter screen', async () => {
    renderAt('/counter/orders');
    await user.click(await screen.findByRole('button', { name: 'Synced' }));
    expect(await screen.findByRole('heading', { name: 'Sync' })).toBeInTheDocument();
  });
});
