import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { pendingVoidRequests, recordPayment } from '../data/commands';
import { KauntaDB } from '../data/db';
import type { RecordContext } from '../data/outbox';
import { DbProvider } from '../data/react';
import { seedDatabase } from '../data/seedDb';
import { addExpense, removeExpense, shiftSummary } from '../data/shifts';
import { voidLines } from '../data/voids';
import { orderDue } from '../domain/orders';
import { I18nProvider } from '../lib/I18nProvider';
import { OrderDetailScreen } from './OrderDetailScreen';
import { SellScreen } from './SellScreen';
import { SessionProvider } from './Session';
import { ShiftScreen } from './ShiftScreen';
import { VoidScreen } from './VoidScreen';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();
const NOW = Date.parse('2026-11-10T19:20:00.000Z');
const wanjiku: RecordContext = { person_id: 'p_wanjiku', device_id: 'd_counter1', now: () => new Date(NOW) };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  localStorage.removeItem('kaunta.seenDecisions');
  db = new KauntaDB(`kaunta-approvals-${++n}`);
  await seedDatabase(db);
});
afterEach(async () => {
  vi.useRealTimers();
  await db.delete();
});

function renderAt(path: string, person = 'p_wanjiku') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider initialLocale="en">
        <DbProvider db={db}>
          <SessionProvider initialPersonId={person}>
            <Routes>
              <Route path="/counter/sell" element={<SellScreen />} />
              <Route path="/counter/orders" element={<p>orders</p>} />
              <Route path="/counter/orders/:id" element={<OrderDetailScreen />} />
              <Route path="/counter/orders/:id/void" element={<VoidScreen />} />
              <Route path="/counter/shift/close" element={<ShiftScreen />} />
              <Route path="/counter/login" element={<p>login screen</p>} />
            </Routes>
          </SessionProvider>
        </DbProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

/** An admin's decision, as it arrives with a pull. */
async function decide(approvalId: string, status: 'approved' | 'rejected') {
  await db.approvals.update(approvalId, { status, decided_by: 'p_njeri', decided_at: new Date(NOW + 60_000).toISOString() });
  if (status === 'rejected') {
    const a = (await db.approvals.get(approvalId))!;
    if (a.target.line_ids.length) await db.lines.where('id').anyOf(a.target.line_ids).modify({ status: 'active' });
  }
}

async function voidRequest(orderId = 'o_048') {
  await voidLines(db, wanjiku, { order_id: orderId, items: [], whole_order: true, reason: 'other' });
  return (await pendingVoidRequests(db, orderId))[0]!;
}

describe('expenses wait for approval', () => {
  it('each expense is a waiting approval; rejected, it stops counting and cannot be removed', async () => {
    const before = (await shiftSummary(db, 'p_wanjiku', 'd_counter1'))!.expected_cash_kes;
    const ice = await addExpense(db, wanjiku, { label: 'Ice blocks', amount_kes: 400, paid_from: 'cash' });
    const approval = (await db.approvals.toArray()).find((a) => a.kind === 'expense' && a.target.expense_id === ice.id)!;
    expect(approval).toMatchObject({ status: 'waiting', amount_kes: 400, reason_code: 'cash', requested_by: 'p_wanjiku', detail: { label: 'Ice blocks' } });
    expect((await shiftSummary(db, 'p_wanjiku', 'd_counter1'))!.expected_cash_kes).toBe(before - 400);

    await decide(approval.id, 'rejected');
    expect((await shiftSummary(db, 'p_wanjiku', 'd_counter1'))!.expected_cash_kes).toBe(before);
    await expect(removeExpense(db, wanjiku, ice.id!)).rejects.toThrow(/decided/);
  });

  it('removed while waiting: its approval is cancelled', async () => {
    const ice = await addExpense(db, wanjiku, { label: 'Ice blocks', amount_kes: 400, paid_from: 'cash' });
    await removeExpense(db, wanjiku, ice.id!);
    expect((await db.approvals.toArray()).find((a) => a.target.expense_id === ice.id)?.status).toBe('cancelled');
  });
});

describe('paying takes back a void request', () => {
  it('paid in full: the request is cancelled first, the lines are sold, the order is paid', async () => {
    const request = await voidRequest();
    const due = orderDue(await db.lines.where('order_id').equals('o_048').toArray(), await db.payments.where('order_id').equals('o_048').toArray());
    await recordPayment(db, wanjiku, 'o_048', [{ method: 'cash', amount_kes: due }]);
    expect((await db.approvals.get(request.id))!.status).toBe('cancelled');
    expect((await db.lines.where('order_id').equals('o_048').toArray()).every((l) => l.status === 'active')).toBe(true);
    expect((await db.orders.get('o_048'))!.status).toBe('paid');
    const types = (await db.outbox.toArray()).map((e) => e.type);
    expect(types.indexOf('void_request_cancelled')).toBeLessThan(types.lastIndexOf('payment_recorded'));
  });

  it('a part payment leaves the request waiting', async () => {
    const request = await voidRequest();
    await recordPayment(db, wanjiku, 'o_048', [{ method: 'cash', amount_kes: 100 }]);
    expect((await db.approvals.get(request.id))!.status).toBe('waiting');
  });

  it('the payment sheet says so before confirming paying all of it', async () => {
    await voidRequest();
    renderAt('/counter/orders/o_048');
    await user.click(await screen.findByRole('button', { name: /^Confirm payment/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Paying for this order takes back the void request for/);
    await user.click(screen.getByRole('button', { name: /Part of it/ }));
    expect(screen.queryByText(/takes back the void request/)).toBeNull();
  });
});

describe('rejections reach the counter', () => {
  it('a rejected void request and a rejected expense show on Sell until OK', async () => {
    const request = await voidRequest();
    const ice = await addExpense(db, wanjiku, { label: 'Ice blocks', amount_kes: 400, paid_from: 'cash' });
    const expenseApproval = (await db.approvals.toArray()).find((a) => a.target.expense_id === ice.id)!;
    await decide(request.id, 'rejected');
    await decide(expenseApproval.id, 'rejected');
    renderAt('/counter/sell');
    const notices = await screen.findByRole('region', { name: 'An admin decided' });
    expect(within(notices).getByText(/Your void request on #048 was rejected by Njeri/)).toBeInTheDocument();
    expect(within(notices).getByText('Your expense Ice blocks · KES 400 was rejected by Njeri. It is not taken off the cash expected.')).toBeInTheDocument();
    const voidNotice = within(notices).getByText(/Your void request/).closest('.c-notice') as HTMLElement;
    await user.click(within(voidNotice).getByRole('button', { name: 'OK' }));
    expect(within(notices).queryByText(/Your void request/)).toBeNull();
    expect(JSON.parse(localStorage.getItem('kaunta.seenDecisions')!)).toEqual([request.id]);
  });

  it('nobody else sees them', async () => {
    const request = await voidRequest();
    await decide(request.id, 'rejected');
    renderAt('/counter/sell', 'p_otieno');
    await screen.findByRole('button', { name: /Switch user · Otieno/ });
    expect(screen.queryByRole('region', { name: 'An admin decided' })).toBeNull();
  });
});

describe('void screen on a paid order', () => {
  it('says up front that an admin decides, even inside the window with a self-void reason', async () => {
    const lines = await db.lines.where('order_id').equals('o_048').toArray();
    await db.lines.where('order_id').equals('o_048').modify({ created_at: new Date(NOW - 30_000).toISOString(), recorded_by: 'p_wanjiku' });
    const due = orderDue(lines, await db.payments.where('order_id').equals('o_048').toArray());
    await recordPayment(db, wanjiku, 'o_048', [{ method: 'cash', amount_kes: due - 1 }]);
    renderAt('/counter/orders/o_048/void');
    expect(await screen.findByText('Already paid: an admin decides')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Whole order/ }));
    await user.click(screen.getByRole('radio', { name: 'Entered by mistake' }));
    expect(screen.getByRole('button', { name: 'Send to admin for approval' })).toBeInTheDocument();
  });
});

describe('close shift with no shift open', () => {
  it('says so and offers to switch user, instead of an empty page', async () => {
    await db.shifts.where('person_id').equals('p_wanjiku').modify({ closed_at: new Date(NOW).toISOString() });
    renderAt('/counter/shift/close');
    expect(await screen.findByText('No shift is open for you on this phone.')).toBeInTheDocument();
    await act(async () => user.click(screen.getByRole('button', { name: 'Switch user' })));
    expect(await screen.findByText('login screen')).toBeInTheDocument();
  });
});
