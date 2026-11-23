import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { KauntaDB } from '../data/db';
import { DbProvider } from '../data/react';
import { seedDatabase } from '../data/seedDb';
import { I18nProvider } from '../lib/I18nProvider';
import { SessionProvider } from './Session';
import { ShiftSalesScreen } from './ShiftSalesScreen';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();

beforeEach(async () => {
  // The counter snapshot: 22:20 Nairobi on business day 10 Nov.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T19:20:00.000Z'));
  db = new KauntaDB(`kaunta-sales-${++n}`);
  await seedDatabase(db);
  // A sale of Wanjiku's on the day before, on another phone.
  const o = (await db.orders.get('o_047'))!;
  await db.orders.put({ ...o, id: 'o_old', short_no: '#012', label: 'Table 7', status: 'paid', business_day: '2026-11-09', device_id: 'd_counter2', created_at: '2026-11-09T18:00:00.000Z' });
  const line = (await db.lines.where('order_id').equals('o_047').first())!;
  await db.lines.put({ ...line, id: 'l_old', order_id: 'o_old' });
});
afterEach(async () => {
  vi.useRealTimers();
  await db.delete();
});

function Where() {
  const { search } = useLocation();
  return <output data-testid="search">{search}</output>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider initialLocale="en">
        <DbProvider db={db}>
          <SessionProvider initialPersonId="p_wanjiku">
            <Routes>
              <Route path="/counter/shift/sales" element={<><ShiftSalesScreen /><Where /></>} />
            </Routes>
          </SessionProvider>
        </DbProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('Sales this shift: another day', () => {
  it('picks a day from the calendar and shows that day’s sales, then goes back to this shift', async () => {
    renderAt('/counter/shift/sales');
    expect(await screen.findByRole('heading', { name: 'Sales History' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pick another day · Tue 10 Nov' })).toBeInTheDocument();
    const field = screen.getByLabelText('Day');
    expect(field).toHaveAttribute('min', '2026-11-09');
    expect(field).toHaveAttribute('max', '2026-11-10');

    fireEvent.change(field, { target: { value: '2026-11-09' } });
    expect(await screen.findByRole('heading', { name: 'My sales' })).toBeInTheDocument();
    expect(screen.getAllByText('Mon 9 Nov').length).toBeGreaterThan(0);
    expect(screen.getByTestId('search')).toHaveTextContent('?day=2026-11-09');
    expect(screen.getByRole('link', { name: /Table 7/ })).toHaveAttribute('href', '/counter/orders/o_old');
    expect(screen.getByRole('button', { name: 'Paid · 1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to this shift' }));
    expect(await screen.findByRole('heading', { name: 'Sales History' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Table 7/ })).toBeNull();
  });

  it('opens on a day from the address (back from an order), and says when there is nothing that day', async () => {
    await db.orders.delete('o_old');
    renderAt('/counter/shift/sales?day=2026-11-09');
    expect(await screen.findByRole('heading', { name: 'My sales' })).toBeInTheDocument();
    expect(screen.getAllByText('Mon 9 Nov').length).toBeGreaterThan(0);
    expect(screen.getByText('No sales of yours on this day.')).toBeInTheDocument();
  });
});

describe('Sales this shift: expenses', () => {
  async function addExpenses() {
    const shift = (await db.shifts.where('[person_id+device_id]').equals(['p_wanjiku', 'd_counter1']).filter((s) => s.closed_at === null).first())!;
    await db.shifts.update(shift.id, {
      expenses: [
        { id: 'x1', label: 'Ice', amount_kes: 300, paid_from: 'cash', at: '2026-11-10T18:30:00.000Z' },
        { id: 'x2', label: 'Airtime', amount_kes: 200, paid_from: 'mpesa', at: '2026-11-10T18:40:00.000Z' },
        { id: 'x3', label: 'Taxi', amount_kes: 500, paid_from: 'cash', at: '2026-11-10T18:50:00.000Z' },
      ],
    });
    const approval = (id: string, expense_id: string, status: 'waiting' | 'approved' | 'rejected') => ({
      id, kind: 'expense' as const, target: { order_id: null, line_ids: [], whole_order: false, shift_id: shift.id, expense_id }, amount_kes: 0,
      reason_code: 'cash', requested_by: 'p_wanjiku', device_id: 'd_counter1', requested_at: '2026-11-10T18:30:00.000Z', status,
      decided_by: status === 'waiting' ? null : 'p_njeri', decided_at: null,
    });
    await db.approvals.bulkPut([approval('ax1', 'x1', 'approved'), approval('ax2', 'x2', 'waiting'), approval('ax3', 'x3', 'rejected')]);
  }

  it('shows the expenses total under the sales total, without rejected ones', async () => {
    await addExpenses();
    renderAt('/counter/shift/sales');
    expect(await screen.findByText('3 expenses')).toBeInTheDocument();
    expect(screen.getByText('KES 500')).toBeInTheDocument();
  });

  it('the Expenses tab lists each one with where it was paid from and its approval', async () => {
    await addExpenses();
    renderAt('/counter/shift/sales');
    await user.click(await screen.findByRole('button', { name: 'Expenses · 3' }));
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('strong')?.textContent)).toEqual(['Taxi', 'Airtime', 'Ice']);
    expect(rows[0]).toHaveTextContent('Cash drawer · 21:50');
    expect(rows[0]).toHaveTextContent('Rejected · not taken off');
    expect(rows[1]).toHaveTextContent('M-Pesa till');
    expect(rows[1]).toHaveTextContent('Waiting for approval');
    expect(rows[2]).toHaveTextContent('Approved');
    expect(screen.queryByRole('link', { name: /Table/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Add or remove expenses' })).toHaveAttribute('href', '/counter/shift/expenses');
  });
});
