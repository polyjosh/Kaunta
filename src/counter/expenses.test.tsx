import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { recordPayment } from '../data/commands';
import { KauntaDB } from '../data/db';
import type { RecordContext } from '../data/outbox';
import { DbProvider } from '../data/react';
import { seedDatabase } from '../data/seedDb';
import { addExpense, handOverOrder, openShiftOf, removeExpense, shiftSummary, startShift } from '../data/shifts';
import { voidLines } from '../data/voids';
import { mpesaVariance, tillPaidOut } from '../domain/admin';
import { expectedCash, expensesTotal, tillExpensesTotal } from '../domain/shifts';
import { I18nProvider } from '../lib/I18nProvider';
import { ExpensesScreen } from './ExpensesScreen';
import { SessionProvider } from './Session';
import { ShiftScreen } from './ShiftScreen';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();
const NOW = Date.parse('2026-11-10T19:20:00.000Z'); // 22:20 Nairobi, the counter snapshot
const wanjiku: RecordContext = { person_id: 'p_wanjiku', device_id: 'd_counter1', now: () => new Date(NOW) };
const kiprop: RecordContext = { person_id: 'p_kiprop', device_id: 'd_counter1', now: () => new Date(NOW) };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  db = new KauntaDB(`kaunta-expenses-${++n}`);
  await seedDatabase(db);
});
afterEach(async () => {
  vi.useRealTimers();
  await db.delete();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider initialLocale="en">
        <DbProvider db={db}>
          <SessionProvider initialPersonId="p_wanjiku">
            <Routes>
              <Route path="/counter/shift/expenses" element={<ExpensesScreen />} />
              <Route path="/counter/shift/close" element={<ShiftScreen />} />
              <Route path="/counter/sell" element={<p>sell screen</p>} />
            </Routes>
          </SessionProvider>
        </DbProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('the money in a shift', () => {
  it('cash expenses come off the cash expected; till expenses do not, and lower what the till should show', () => {
    const shift = { float_kes: 2000, cash_baseline_kes: 0, expenses: [{ label: 'Ice', amount_kes: 300, paid_from: 'cash' as const }, { label: 'Airtime', amount_kes: 100, paid_from: 'mpesa' as const }, { label: 'Old', amount_kes: 50 }] };
    expect(expensesTotal(shift)).toBe(350);
    expect(tillExpensesTotal(shift)).toBe(100);
    expect(expectedCash(shift, [{ method: 'cash', amount_kes: 1000 }])).toBe(2650);
    expect(mpesaVariance(5000, 4900, tillPaidOut([{ till_expenses_kes: 100 }]))).toEqual({ kind: 'matches', amount_kes: 0 });
    expect(mpesaVariance(5000, 4900)).toEqual({ kind: 'notOnTill', amount_kes: 100 });
  });

  it('a new shift starts with the float counted; one already open keeps its own', async () => {
    const opened = await startShift(db, kiprop, 1500);
    expect(opened.float_kes).toBe(1500);
    expect((await startShift(db, kiprop, 9999)).float_kes).toBe(1500);
    await expect(startShift(db, { ...kiprop, person_id: 'p_akinyi' }, 10.5)).rejects.toThrow(RangeError);
    const event = (await db.outbox.toArray()).find((e) => e.type === 'shift_opened' && e.recorded_by === 'p_kiprop');
    expect(event?.payload).toMatchObject({ shift: { float_kes: 1500 } });
  });

  it('expenses are recorded on the open shift, checked, and can be taken off', async () => {
    const ice = await addExpense(db, wanjiku, { label: '  Ice  ', amount_kes: 300, paid_from: 'cash' });
    expect(ice).toMatchObject({ label: 'Ice', amount_kes: 300, paid_from: 'cash' });
    await expect(addExpense(db, wanjiku, { label: 'x', amount_kes: 0, paid_from: 'cash' })).rejects.toThrow(RangeError);
    await expect(addExpense(db, wanjiku, { label: ' ', amount_kes: 5, paid_from: 'cash' })).rejects.toThrow(RangeError);
    await expect(addExpense(db, { ...wanjiku, person_id: 'p_akinyi' }, { label: 'x', amount_kes: 5, paid_from: 'cash' })).rejects.toThrow(/No open shift/);
    const shift = (await openShiftOf(db, 'p_wanjiku', 'd_counter1'))!;
    expect(shift.expenses.at(-1)).toMatchObject({ id: ice.id, label: 'Ice' });
    await removeExpense(db, wanjiku, ice.id!);
    expect((await openShiftOf(db, 'p_wanjiku', 'd_counter1'))!.expenses.some((e) => e.id === ice.id)).toBe(false);
    expect((await db.outbox.toArray()).filter((e) => e.type.startsWith('shift_expense')).map((e) => e.type)).toEqual(['shift_expense_added', 'shift_expense_removed']);
  });
});

describe('Expenses this shift (screen)', () => {
  it('adds an expense from the drawer or the till, and the close counts only the drawer ones', async () => {
    const before = (await shiftSummary(db, 'p_wanjiku', 'd_counter1'))!.expected_cash_kes;
    renderAt('/counter/shift/expenses');
    await user.click(await screen.findByRole('button', { name: 'Add expense' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Say what the money was for.');

    await user.type(screen.getByLabelText('What was it for?'), 'Ice blocks');
    await user.type(screen.getByLabelText('Amount'), '450');
    await user.click(screen.getByRole('button', { name: 'Add expense' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose where the money came from.');
    await user.click(screen.getByRole('radio', { name: 'Cash drawer' }));
    await user.click(screen.getByRole('button', { name: 'Add expense' }));
    expect(await screen.findByText('Added: Ice blocks · KES 450')).toBeInTheDocument();

    await user.type(screen.getByLabelText('What was it for?'), 'Supplier airtime');
    await user.type(screen.getByLabelText('Amount'), '200');
    await user.click(screen.getByRole('radio', { name: 'M-Pesa till' }));
    await user.click(screen.getByRole('button', { name: 'Add expense' }));
    const list = await screen.findByRole('list');
    expect(await within(list).findByText('Supplier airtime')).toBeInTheDocument();

    const summary = (await shiftSummary(db, 'p_wanjiku', 'd_counter1'))!;
    expect(summary.expected_cash_kes).toBe(before - 450);
    expect(tillExpensesTotal(summary.shift)).toBe(200);

    await user.click(within(list).getByRole('button', { name: 'Remove Ice blocks' }));
    await waitFor(() => expect(within(list).queryByText('Ice blocks')).toBeNull());
    expect(within(list).getByText('Supplier airtime')).toBeInTheDocument();
    expect((await shiftSummary(db, 'p_wanjiku', 'd_counter1'))!.expected_cash_kes).toBe(before);
  });

  it('the close shows the drawer expenses, links to add one, and notes what the till paid out', async () => {
    await recordPayment(db, wanjiku, 'o_048', [{ method: 'mpesa', amount_kes: 600 }]);
    await handOverOrder(db, wanjiku, 'o_047');
    await voidLines(db, wanjiku, { order_id: 'o_044', items: [], whole_order: true, reason: 'other' });
    await addExpense(db, wanjiku, { label: 'Airtime', amount_kes: 250, paid_from: 'mpesa' });
    renderAt('/counter/shift/close');
    expect(await screen.findByText('Expected in the drawer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add' })).toHaveAttribute('href', '/counter/shift/expenses');
    expect(screen.getByText(/KES 250 paid out from the till/)).toBeInTheDocument();
  });
});
