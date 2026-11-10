import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { addItems, moveToNewOrder, recordPayment } from '../data/commands';
import { KauntaDB } from '../data/db';
import { pendingEvents } from '../data/outbox';
import type { RecordContext } from '../data/outbox';
import { DbProvider } from '../data/react';
import { seedDatabase } from '../data/seedDb';
import { shiftSummary } from '../data/shifts';
import { orderDue, orderTotal } from '../domain/orders';
import { I18nProvider } from '../lib/I18nProvider';
import { OrderDetailScreen } from './OrderDetailScreen';
import { OrdersScreen } from './OrdersScreen';
import { SellScreen } from './SellScreen';
import { SessionProvider } from './Session';
import { SyncScreen } from './SyncScreen';
import { VoidScreen } from './VoidScreen';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();
const NOW = '2026-11-10T19:20:00.000Z'; // 22:20 Nairobi
const ctx = (person = 'p_wanjiku'): RecordContext => ({ person_id: person, device_id: 'd_counter1', now: () => new Date(NOW) });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  db = new KauntaDB(`kaunta-addmove-${++n}`);
  await seedDatabase(db);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await db.delete();
});

const linesOf = (id: string) => db.lines.where('order_id').equals(id).toArray();
const paymentsOf = (id: string) => db.payments.where('order_id').equals(id).toArray();

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider initialLocale="en">
        <DbProvider db={db}>
          <SessionProvider initialPersonId="p_wanjiku">
            <Routes>
              <Route path="/counter/sell" element={<SellScreen />} />
              <Route path="/counter/orders" element={<OrdersScreen />} />
              <Route path="/counter/orders/:id" element={<OrderDetailScreen />} />
              <Route path="/counter/orders/:id/void" element={<VoidScreen />} />
              <Route path="/counter/sync" element={<SyncScreen />} />
            </Routes>
          </SessionProvider>
        </DbProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('addItems', () => {
  it('adds lines at today’s price, recorded by whoever adds them, and takes stock', async () => {
    const lines = await addItems(db, ctx('p_akinyi'), 'o_044', [{ size_id: 'guinness_0', qty: 2 }]);
    expect(lines).toMatchObject([{ qty: 2, unit_price_kes: 330, recorded_by: 'p_akinyi', status: 'active' }]);
    expect(orderTotal(await linesOf('o_044'))).toBe(1250 + 660);
    expect(orderDue(await linesOf('o_044'), await paymentsOf('o_044'))).toBe(850 + 660);
    expect((await db.products.get('guinness'))?.stock_qty).toBe(16);
    expect((await db.orders.get('o_044'))?.recorded_by).toBe('p_wanjiku'); // the order's own author is unchanged
    expect((await pendingEvents(db)).at(-1)).toMatchObject({ type: 'lines_added', recorded_by: 'p_akinyi' });
  });

  it('refuses orders that are not open, and products switched off', async () => {
    await db.orders.update('o_048', { status: 'paid' });
    await expect(addItems(db, ctx(), 'o_048', [{ size_id: 'tusker_0', qty: 1 }])).rejects.toThrow(/not open/);
    await expect(addItems(db, ctx(), 'o_044', [{ size_id: 'cider_0', qty: 1 }])).rejects.toThrow(/out of stock/);
    await expect(addItems(db, ctx(), 'o_044', [])).rejects.toThrow(RangeError);
    expect(await pendingEvents(db)).toHaveLength(0);
  });
});

describe('moveToNewOrder (R-ORD-5 split by items)', () => {
  it('moves some units to a new order with the same table and server; authorship stays', async () => {
    const tusker = (await linesOf('o_047')).find((l) => l.size_id === 'tusker_0')!; // 2× Tusker
    const created = await moveToNewOrder(db, ctx(), 'o_047', [{ line_id: tusker.id, qty: 1 }]);

    expect(created).toMatchObject({
      short_no: '#049',
      label: 'Table 4',
      server_id: 'p_wanjiku',
      business_day: '2026-11-10',
      recorded_by: 'p_wanjiku',
      status: 'open',
    });
    const moved = await linesOf(created.id);
    expect(moved).toMatchObject([{ size_id: 'tusker_0', qty: 1, unit_price_kes: 300, recorded_by: 'p_wanjiku', created_at: tusker.created_at }]);
    expect((await db.lines.get(tusker.id))?.qty).toBe(1);
    expect(orderTotal(await linesOf('o_047'))).toBe(950);
    expect(orderTotal(moved)).toBe(300);
    expect((await db.products.get('tusker'))?.stock_qty).toBe(24); // stock does not move
  });

  it('moves whole lines when all their units go', async () => {
    const cane = (await linesOf('o_047')).find((l) => l.size_id === 'cane_2')!;
    const created = await moveToNewOrder(db, ctx(), 'o_047', [{ line_id: cane.id, qty: 1 }]);
    expect((await db.lines.get(cane.id))?.order_id).toBe(created.id);
  });

  it('leaves the payments where they are; an order whose rest is covered becomes paid', async () => {
    // Table 9: 1,250 with 400 paid. Move everything but the Kenya Cane (350) + Kachumbari (100) = 450 staying.
    const lines = await linesOf('o_044');
    const byId = (size: string) => lines.find((l) => l.size_id === size)!;
    await expect(
      moveToNewOrder(db, ctx(), 'o_044', [
        { line_id: byId('tusker_0').id, qty: 2 },
        { line_id: byId('soda_1').id, qty: 2 },
        { line_id: byId('cane_1').id, qty: 1 },
      ]),
    ).rejects.toThrow(/400 is already paid/); // only KES 100 would stay

    await moveToNewOrder(db, ctx(), 'o_044', [
      { line_id: byId('tusker_0').id, qty: 2 },
      { line_id: byId('soda_1').id, qty: 1 },
    ]);
    expect(orderTotal(await linesOf('o_044'))).toBe(550);
    expect(orderDue(await linesOf('o_044'), await paymentsOf('o_044'))).toBe(150);
    expect(await paymentsOf('o_044')).toHaveLength(1);

    await recordPayment(db, ctx(), 'o_044', [{ method: 'cash', amount_kes: 150 }]);
    expect((await db.orders.get('o_044'))?.status).toBe('paid');
  });

  it('refuses to empty the order, to move more than there is, or to move a line waiting on a void', async () => {
    const [line] = await linesOf('o_048'); // 2× Tusker, the only line
    await expect(moveToNewOrder(db, ctx(), 'o_048', [{ line_id: line!.id, qty: 2 }])).rejects.toThrow(/at least one item/);
    await expect(moveToNewOrder(db, ctx(), 'o_048', [{ line_id: line!.id, qty: 3 }])).rejects.toThrow(RangeError);
    await db.lines.update(line!.id, { status: 'void_pending' });
    await expect(moveToNewOrder(db, ctx(), 'o_048', [{ line_id: line!.id, qty: 1 }])).rejects.toThrow(/cannot be moved/);
    expect(await pendingEvents(db)).toHaveLength(0);
  });

  it('the new order belongs to whoever split it at shift close', async () => {
    const tusker = (await linesOf('o_041')).find((l) => l.size_id === 'tusker_0')!; // Akinyi's order
    const created = await moveToNewOrder(db, ctx(), 'o_041', [{ line_id: tusker.id, qty: 1 }]);
    const blocking = (await shiftSummary(db, 'p_wanjiku', 'd_counter1'))!.blocking.map((o) => o.id);
    expect(blocking).toContain(created.id);
  });
});

describe('Add items from Order detail', () => {
  it('opens Sell for that order; the tray adds to it and returns to the order', async () => {
    renderAt('/counter/orders/o_044');
    await user.click(await screen.findByRole('button', { name: 'Add items' }));

    expect(await screen.findByText('Adding to Table 9 #044')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Server:/ })).toBeNull(); // the order already has one
    expect(screen.queryByRole('button', { name: 'Record & paid' })).toBeNull();
    const add = screen.getByRole('button', { name: 'Add to #044' });
    expect(add).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Guinness' }));
    await user.click(screen.getByRole('button', { name: 'Guinness, 1 in order' }));
    await user.click(add);

    expect(await screen.findByText('2 items added to #044')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Table 9 #044' })).toBeInTheDocument();
    expect(screen.getByText('Items · 8')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm payment · KES 1,510' })).toBeInTheDocument();
  });

  it('can be cancelled back to the order without adding anything', async () => {
    renderAt('/counter/sell?order=o_044');
    await user.click(await screen.findByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'Table 9 #044' })).toBeInTheDocument();
    expect(await pendingEvents(db)).toHaveLength(0);
  });
});

describe('Split by items from Order detail', () => {
  it('from a line’s menu: moves one unit to a new order and opens it', async () => {
    renderAt('/counter/orders/o_047');
    await user.click(await screen.findByRole('button', { name: 'Options for Tusker Lager 500ml' }));
    await user.click(screen.getByRole('button', { name: 'Move to a new order' }));

    const sheet = screen.getByRole('dialog', { name: 'Move to a new order' });
    expect(within(sheet).getByText(/Payments already taken stay on this order/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Move 1 item to a new order' }));

    expect(await screen.findByText('Moved to a new order #049')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Table 4 #049' })).toBeInTheDocument();
    expect(screen.getByText('Items · 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm payment · KES 300' })).toBeInTheDocument();
  });

  it('from Split bill: pick how many of each; the button explains what cannot move', async () => {
    renderAt('/counter/orders/o_044'); // KES 400 already paid
    await user.click(await screen.findByRole('button', { name: 'Split bill' }));
    await user.click(screen.getByRole('button', { name: 'Split by items' }));
    const sheet = screen.getByRole('dialog', { name: 'Move to a new order' });
    const button = () => within(sheet).getByRole('button', { name: /to a new order$/ });
    expect(button()).toBeDisabled();

    await user.click(within(sheet).getByRole('button', { name: 'Add one: Tusker Lager 500ml' }));
    await user.click(within(sheet).getByRole('button', { name: 'Add one: Tusker Lager 500ml' }));
    expect(within(sheet).getByRole('button', { name: 'Add one: Tusker Lager 500ml' })).toBeDisabled(); // only 2
    await user.click(within(sheet).getByRole('button', { name: 'Add one: Kenya Cane 250ml' }));
    await user.click(within(sheet).getByRole('button', { name: 'Add one: Soda 500ml' }));
    expect(within(sheet).getByText('KES 400 is already paid on this order, so at least that much has to stay.')).toBeInTheDocument();
    expect(button()).toBeDisabled();

    await user.click(within(sheet).getByRole('button', { name: 'Remove one: Kenya Cane 250ml' }));
    expect(button()).toHaveAccessibleName('Move 3 items to a new order');
    await user.click(button());
    expect(await screen.findByText('Moved to a new order #049')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Confirm payment · KES 700' })).toBeInTheDocument();
  });

  it('is not offered when only one item is on the order', async () => {
    await db.lines.where('order_id').equals('o_048').modify({ qty: 1 });
    renderAt('/counter/orders/o_048');
    await user.click(await screen.findByRole('button', { name: 'Options for Tusker Lager 500ml' }));
    expect(screen.queryByRole('button', { name: 'Move to a new order' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Void this item' })).toBeInTheDocument();
  });
});

describe('Offline confirmations', () => {
  const offline = () => vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const saved = 'Saved on this phone. It will sync when the internet is back.';

  it('a sale recorded offline says it is saved on this phone, in grey, and still offers Undo', async () => {
    offline();
    renderAt('/counter/sell');
    await user.click(await screen.findByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Record (pay later)' }));

    const toast = await screen.findByText('Order #049 recorded · No table · pay later');
    expect(toast.closest('.c-toast')).toHaveClass('is-offline');
    expect(screen.getByText(saved)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Offline · 1 saved' })).toBeInTheDocument();
  });

  it('online, the same sale has no offline note', async () => {
    renderAt('/counter/sell');
    await user.click(await screen.findByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Record (pay later)' }));
    await screen.findByText('Order #049 recorded · No table · pay later');
    expect(screen.queryByText(saved)).toBeNull();
  });

  it('a payment taken offline says the same', async () => {
    offline();
    renderAt('/counter/orders/o_047');
    await user.click(await screen.findByRole('button', { name: 'Confirm payment · KES 1,250' }));
    await user.click(screen.getByRole('radio', { name: 'Cash' }));
    await user.click(screen.getByRole('button', { name: 'Confirm KES 1,250 received' }));
    expect(await screen.findByText('#047 paid in full by cash')).toBeInTheDocument();
    expect(screen.getByText(saved)).toBeInTheDocument();
  });

  it('a request that goes to an admin keeps its yellow toast, offline or not', async () => {
    offline();
    renderAt('/counter/orders/o_039/void');
    await user.click(await screen.findByRole('radio', { name: /Whole order/ }));
    await user.click(screen.getByRole('radio', { name: 'Entered by mistake' }));
    await user.click(screen.getByRole('button', { name: 'Send to admin for approval' }));
    const toast = await screen.findByText('Sent to admin · waiting for approval');
    expect(toast.closest('.c-toast')).toHaveClass('is-warning');
  });

  it('the Sync list names the new kinds of entry', async () => {
    const tusker = (await linesOf('o_047')).find((l) => l.size_id === 'tusker_0')!;
    await addItems(db, ctx(), 'o_044', [{ size_id: 'soda_1', qty: 1 }]);
    await moveToNewOrder(db, ctx(), 'o_047', [{ line_id: tusker.id, qty: 1 }]);
    renderAt('/counter/sync');
    expect(await screen.findByText('Items added to #044')).toBeInTheDocument();
    expect(screen.getByText('Moved to new order #049')).toBeInTheDocument();
  });
});
