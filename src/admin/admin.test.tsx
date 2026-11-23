import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { seedAdminDatabase } from '../data/adminSeed';
import { KauntaDB } from '../data/db';
import { verifyPin } from '../domain/pin';
import { SAMPLE_NOW } from '../domain/sampleDay';
import { I18nProvider } from '../lib/I18nProvider';
import type { Locale } from '../lib/i18n';
import { ThemeProvider } from '../lib/ThemeProvider';
import { AdminApp } from './AdminApp';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();

beforeEach(async () => {
  // The sample night at 02:14; the demo clock runs from here.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SAMPLE_NOW));
  db = new KauntaDB(`kaunta-admin-ui-${++n}`);
  await seedAdminDatabase(db, { now: new Date(SAMPLE_NOW) });
});
afterEach(async () => {
  vi.useRealTimers();
  await db.delete();
});

function renderAt(path: string, locale: Locale = 'en') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider initialLocale={locale}>
        <ThemeProvider>
          <Routes>
            <Route path="/admin/*" element={<AdminApp db={db} />} />
          </Routes>
        </ThemeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('Today (R-DAY-4)', () => {
  it('shows the seed numbers and the answer', async () => {
    renderAt('/admin');
    expect(await screen.findByText('KES 86,450')).toBeInTheDocument();
    expect(screen.getByText('KES 79,970')).toBeInTheDocument();
    expect(screen.getByText('KES 6,480')).toBeInTheDocument();
    expect(screen.getByText('KES 31,570')).toBeInTheDocument();
    expect(screen.getByText('KES 48,400')).toBeInTheDocument();
    expect(screen.getByText(/Not clear yet\. KES 6,480 is still on 5 open orders/)).toBeInTheDocument();
    expect(screen.getByText('So far, up to 02:14 · the business day closes at 06:00')).toBeInTheDocument();
    expect(screen.getByText('Busiest hour: 22:00 · KES 14,300')).toBeInTheDocument();
  });

  it('lists what needs attention, each with colour, icon and words', async () => {
    renderAt('/admin');
    expect(await screen.findByText('Pilsner is at −4 bottles')).toBeInTheDocument();
    expect(screen.getByText('2 voids waiting for you · KES 2,630')).toBeInTheDocument();
    expect(screen.getByText('#039 Guinness ×1 (Otieno) · #041 whole order (Akinyi)')).toBeInTheDocument();
    expect(screen.getByText('Keg finished 9 cups short')).toBeInTheDocument();
    expect(screen.getByText('Keg #K-07: 100 cups expected, 91 recorded · about KES 1,080')).toBeInTheDocument();
    const flag = screen.getByText('Pilsner is at −4 bottles').closest('a')!;
    expect(flag).toHaveAttribute('href', '/admin/stock/new?product=pilsner');
    expect(flag.querySelector('svg')).not.toBeNull();
  });

  it('the calendar loads another day, and Back to today returns', async () => {
    renderAt('/admin');
    await screen.findByText('KES 86,450');
    const field = screen.getByLabelText('Business day');
    expect(field).toHaveAttribute('max', '2026-11-10');
    expect(field).toHaveAttribute('min', '2026-10-06');
    expect(screen.getByRole('button', { name: 'Choose another day (showing Tue 10 Nov)' })).toBeInTheDocument();
    fireEvent.change(field, { target: { value: '2026-11-09' } });
    expect(await screen.findByRole('heading', { name: 'Sales · Mon 9 Nov' })).toBeInTheDocument();
    expect(screen.getByText('Did I lose money on Mon 9 Nov?')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('KES 86,450')).toBeNull());
    expect(screen.getByRole('link', { name: 'Reconcile the day →' })).toHaveAttribute('href', '/admin/reconcile/2026-11-09');
    await user.click(screen.getByRole('link', { name: 'Back to today' }));
    expect(await screen.findByText('KES 86,450')).toBeInTheDocument();
  });

  it('a day in the address that is today or later is today', async () => {
    renderAt('/admin?day=2026-12-31');
    expect(await screen.findByText('KES 86,450')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to today' })).toBeNull();
  });

  it('the Approvals tab carries the waiting count', async () => {
    renderAt('/admin');
    const nav = await screen.findByRole('navigation', { name: 'Admin menu' });
    expect(await within(nav).findByLabelText('5 waiting')).toHaveTextContent('5');
  });

  it('reads in Kiswahili with the same numbers', async () => {
    renderAt('/admin', 'sw');
    expect(await screen.findByText('Je, nimepoteza pesa leo?')).toBeInTheDocument();
    expect(screen.getByText('KES 86,450')).toBeInTheDocument();
    expect(screen.getByText('Pesa iliyo hatarini')).toBeInTheDocument();
  });
});

describe('Approvals', () => {
  it('an expense from the counter waits here; rejected, the shift no longer counts it', async () => {
    const shift = (await db.shifts.get('s_p_akinyi'))!;
    const at = shift.opened_at;
    await db.shifts.update(shift.id, { expenses: [...shift.expenses, { id: 'x_ice', label: 'Ice blocks', amount_kes: 400, paid_from: 'cash', at }] });
    await db.approvals.put({
      id: 'a_x_ice', kind: 'expense', target: { order_id: null, line_ids: [], whole_order: false, shift_id: shift.id, expense_id: 'x_ice' },
      amount_kes: 400, reason_code: 'cash', requested_by: shift.person_id, device_id: shift.device_id, requested_at: at,
      status: 'waiting', decided_by: null, decided_at: null, detail: { label: 'Ice blocks' },
    });
    renderAt('/admin/approvals');
    const card = (await screen.findByRole('heading', { name: 'Ice blocks' })).closest('article')!;
    expect(within(card).getByText('Expense')).toBeInTheDocument();
    expect(within(card).getByText('Cash drawer')).toBeInTheDocument();
    expect(within(card).getByText(/Reject and Akinyi’s shift is short by KES 400/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Reject' }));
    expect(await within(card).findByText(/Rejected · Njeri/)).toBeInTheDocument();
    expect((await db.approvals.get('a_x_ice'))!.status).toBe('rejected');
  });

  it('approving a void takes it off the order, and Undo puts it back', async () => {
    renderAt('/admin/approvals');
    const card = (await screen.findByRole('heading', { name: '#039 Table 2 · Guinness 500ml ×1' })).closest('article')!;
    expect(within(card).getByText('Approving takes KES 330 off #039 and puts Guinness 500ml ×1 back in stock.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Approve void' }));
    expect(await within(card).findByText(/Approved void · Njeri · now/)).toBeInTheDocument();
    expect((await db.approvals.get('a_void_039'))!.status).toBe('approved');
    expect(screen.getByText(/4 waiting/)).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Undo' }));
    expect(await within(card).findByRole('button', { name: 'Approve void' })).toBeInTheDocument();
    expect((await db.approvals.get('a_void_039'))!.status).toBe('waiting');
  });

  it('a price mismatch offers "Accept KES 300" and "Mark KES 20 short"', async () => {
    renderAt('/admin/approvals');
    const card = (await screen.findByRole('heading', { name: '#036 Table 6 · Tusker Lager sold at the old price' })).closest('article')!;
    await user.click(within(card).getByRole('button', { name: 'Mark KES 20 short' }));
    expect(await within(card).findByText(/Marked KES 20 short · Njeri/)).toBeInTheDocument();
    expect((await db.approvals.get('a_price_036'))!.status).toBe('rejected');
  });
});

describe('Reconcile (R-SHIFT-2, R-DAY-3)', () => {
  it('shows each shift and a live M-Pesa variance; the day cannot close while a shift is open', async () => {
    renderAt('/admin/reconcile/2026-11-10');
    expect(await screen.findByRole('heading', { name: 'Reconcile · Tue 10 Nov' })).toBeInTheDocument();
    const wanjiku = screen.getByRole('rowheader', { name: /Wanjiku/ }).closest('tr')!;
    expect(within(wanjiku).getByText('Short KES 300')).toBeInTheDocument();
    expect(within(wanjiku).getByText('12,750')).toBeInTheDocument();
    expect(screen.getByText('Shift open')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Till total in KES'), '47650');
    expect(screen.getByLabelText('Till total in KES')).toHaveValue('47,650');
    expect(screen.getByText('Recorded but not on the till')).toBeInTheDocument();
    // The variance, and the #046 payment without a code that explains it.
    expect(screen.getAllByText('KES 750')).toHaveLength(2);
    expect(screen.getByText('Payments to check first: no M-Pesa code entered')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close the business day' })).toBeDisabled();
  });

  it('takes expenses paid from the M-Pesa till off what the till should show, and leaves the cash alone', async () => {
    const shift = (await db.shifts.get('s_p_akinyi'))!;
    await db.shifts.update(shift.id, { expenses: [...shift.expenses, { id: 'x_1', label: 'Supplier', amount_kes: 750, paid_from: 'mpesa', at: '2026-11-10T20:00:00.000Z' }] });
    renderAt('/admin/reconcile/2026-11-10');
    expect(await screen.findByText('− KES 750 paid out from the till this day · expect KES 47,650 on the statement')).toBeInTheDocument();
    expect(screen.getByText(/Supplier 750 \(M-Pesa till\)/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Till total in KES'), '47650');
    expect(screen.queryByText('Recorded but not on the till')).toBeNull();
    expect(document.querySelector('.a-variance')).toHaveClass('k-tone-paid');
  });

  it('the calendar opens another day', async () => {
    renderAt('/admin/reconcile/2026-11-10');
    await screen.findByRole('heading', { name: 'Reconcile · Tue 10 Nov' });
    fireEvent.change(screen.getByLabelText('Business day'), { target: { value: '2026-11-08' } });
    expect(await screen.findByRole('heading', { name: 'Reconcile · Sun 8 Nov' })).toBeInTheDocument();
    // Nothing outside what this device keeps, and nothing in the future.
    fireEvent.change(screen.getByLabelText('Business day'), { target: { value: '2026-11-20' } });
    expect(screen.getByRole('heading', { name: 'Reconcile · Sun 8 Nov' })).toBeInTheDocument();
  });

  it('closes once every shift is closed, and keeps the difference on record', async () => {
    await db.shifts.update('s_p_akinyi', { closed_at: '2026-11-10T23:10:00.000Z', counted_cash_kes: 14_800, result_kes: 0 });
    renderAt('/admin/reconcile/2026-11-10');
    await user.type(await screen.findByLabelText('Till total in KES'), '47650');
    await user.click(screen.getByRole('button', { name: 'Close the business day' }));
    expect(await screen.findByText(/Day closed by Njeri at 02:14/)).toBeInTheDocument();
    expect(await db.dayCloses.get('2026-11-10')).toMatchObject({ till_total_kes: 47_650, recorded_mpesa_kes: 48_400, closed_by: 'p_njeri' });
  });

  it('an admin closes a shift someone left open, with the cash they count, and then the day can close', async () => {
    renderAt('/admin/reconcile/2026-11-10');
    await user.click(await screen.findByRole('button', { name: 'Close Akinyi’s shift' }));
    const counted = screen.getByLabelText('Cash counted in Akinyi’s drawer (KES)');
    const close = screen.getAllByRole('button', { name: 'Close Akinyi’s shift' }).at(-1)!;
    expect(close).toBeDisabled();
    await user.type(counted, '14000');
    expect(within(counted.closest('.a-close-shift') as HTMLElement).getByText(/^Short KES/)).toBeInTheDocument();
    await user.click(close);
    await waitFor(async () => expect((await db.shifts.get('s_p_akinyi'))!.closed_at).not.toBeNull());
    const shift = (await db.shifts.get('s_p_akinyi'))!;
    expect(shift.counted_cash_kes).toBe(14_000);
    expect(shift.result_kes).toBeLessThan(0);
    expect((await db.auditEvents.where('kind').equals('shift_closed_by_admin').toArray())).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText('Shifts still open')).toBeNull());
    await user.type(screen.getByLabelText('Till total in KES'), '47650');
    expect(screen.getByRole('button', { name: 'Close the business day' })).toBeEnabled();
  });
});

describe('Sales feed', () => {
  it('filters rows and totals by server', async () => {
    renderAt('/admin/sales');
    const table = (await screen.findByRole('heading', { name: 'By server · today' })).closest('section')!;
    const total = within(table).getByRole('rowheader', { name: 'Total' }).closest('tr')!;
    expect(total).toHaveTextContent('86,450');
    expect(total).toHaveTextContent('6,480');
    await user.click(screen.getByRole('button', { name: /Needs review/ }));
    expect(screen.getAllByText('Needs review').length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText('Paid', { selector: '.k-chip span' })).toBeNull();
  });

  it('Served shows each order still to be paid, once, with what is due', async () => {
    renderAt('/admin/sales');
    const served = await screen.findByRole('button', { name: /^Served/ });
    expect(served).toHaveTextContent('5');
    await user.click(served);
    const rows = Array.from(document.querySelectorAll('.a-feed-row'));
    expect(rows).toHaveLength(5);
    const due = rows.map((r) => Number(r.querySelector('.a-feed-amount')!.textContent!.replace(/[^0-9]/g, '')));
    expect(due.reduce((a, b) => a + b, 0)).toBe(6_480);
    expect(screen.getByText('Part paid')).toBeInTheDocument();
    expect(screen.queryByText('Paid', { selector: '.k-chip span' })).toBeNull();
  });
});

describe('Products and stock', () => {
  it('a price change is saved and audited with before → after', async () => {
    renderAt('/admin/products/tusker');
    const price = await screen.findByLabelText('Price of 500ml');
    await user.clear(price);
    await user.type(price, '320');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Saved\. Counters get the change/)).toBeInTheDocument();
    expect((await db.sizes.get('tusker_0'))!.price_kes).toBe(320);
    const audit = (await db.auditEvents.where('kind').equals('product_saved').toArray())[0]!;
    expect((audit.detail as any).before.sizes[0].price_kes).toBe(300);
  });

  it('will not save a product with no size on sale', async () => {
    renderAt('/admin/products/tusker');
    await user.click(await screen.findByRole('switch', { name: 'Sell 500ml' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Keep at least one size on sale');
  });

  it('add stock: a crate of 25 takes Pilsner from −4 to 21 (R-STOCK-2)', async () => {
    renderAt('/admin/stock/new?product=pilsner');
    expect(await screen.findByText('Now −4 → 21 bottles')).toBeInTheDocument();
    expect(screen.getByText(/Pilsner goes back above zero/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add to stock' }));
    expect(await screen.findByText(/Added to stock: 1 product/)).toBeInTheDocument();
    expect((await db.products.get('pilsner'))!.stock_qty).toBe(21);
  });
});

describe('Kegs (R-KEG-1…3)', () => {
  it('shows what is on tap and writes off a finished keg’s missing cups', async () => {
    renderAt('/admin/kegs');
    expect(await screen.findByText('~31 L left')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Write off 9 cups' }));
    expect(await screen.findByText(/9 cups written off by Njeri/)).toBeInTheDocument();
    expect((await db.kegs.get('k07'))!.written_off_cups).toBe(9);
  });

  it('keg finished puts the next one on tap', async () => {
    renderAt('/admin/kegs');
    await user.click(await screen.findByRole('button', { name: 'Keg finished' }));
    expect(await screen.findByRole('heading', { name: 'Keg lager #K-09' })).toBeInTheDocument();
  });
});

describe('Staff & devices (R-PIN-1, R-DEV-2; PINs set by owners and managers)', () => {
  it('unlocks a locked person', async () => {
    renderAt('/admin/staff');
    const row = (await screen.findByRole('rowheader', { name: /Otieno/ })).closest('tr')!;
    expect(within(row).getByText(/PIN locked · 4:5\d/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Unlock' }));
    expect(await within(row).findByText('••••')).toBeInTheDocument();
    expect((await db.people.get('p_otieno'))!.pin_locked_until).toBeNull();
  });

  it('shows a counter person’s PIN on request, and sets a new one: logged, without the digits', async () => {
    renderAt('/admin/staff');
    const row = (await screen.findByRole('rowheader', { name: /Wanjiku/ })).closest('tr')!;
    expect(within(row).getByText('••••')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /^Show/ }));
    expect(within(row).getByText('2580')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Change PIN' }));
    const input = await screen.findByLabelText('New PIN for Wanjiku');
    await user.clear(input);
    await user.type(input, '12');
    expect(screen.getByRole('button', { name: 'Save PIN' })).toBeDisabled();
    await user.type(input, '34');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    const notice = (await screen.findByRole('heading', { name: 'New PIN for Wanjiku' })).closest<HTMLElement>('[role="status"]')!;
    expect(within(notice).getByText('1234')).toBeInTheDocument();
    const wanjiku = (await db.people.get('p_wanjiku'))!;
    expect(wanjiku.pin_code).toBe('1234');
    expect(await verifyPin('1234', wanjiku.pin_hash)).toBe(true);
    const audit = (await db.auditEvents.where('kind').equals('pin_changed').toArray())[0]!;
    expect(audit.ref_id).toBe('p_wanjiku');
    expect(JSON.stringify(audit.detail)).not.toMatch(/1234|pbkdf2/);
    // Owners and managers have their own sign-in; no PIN to show or change here.
    const chebet = (await screen.findByRole('rowheader', { name: /Chebet/ })).closest('tr')!;
    expect(within(chebet).getByText('Their own PIN')).toBeInTheDocument();
    expect(within(chebet).queryByRole('button', { name: /PIN|Suspend/ })).toBeNull();
  });

  it('a new counter person gets a PIN from the owner, shown once and kept to look up', async () => {
    renderAt('/admin/staff');
    await user.click(await screen.findByRole('button', { name: '+ Add person' }));
    await user.type(document.querySelector<HTMLElement>('.a-addperson input')!, 'Baraka');
    const pin = screen.getByLabelText('PIN (4 digits)');
    expect((pin as HTMLInputElement).value).toMatch(/^\d{4}$/);
    await user.clear(pin);
    await user.type(pin, '9753');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('heading', { name: 'New PIN for Baraka' })).toBeInTheDocument();
    const baraka = (await db.people.toArray()).find((p) => p.name === 'Baraka')!;
    expect(baraka).toMatchObject({ role: 'counter', login: 'pin', pin_code: '9753' });
    // Managers come from Kaunta, not from here.
    await user.click(screen.getByRole('button', { name: '+ Add person' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Counter staff', 'Server']);
  });

  it('suspends someone (off the counter, history kept) and gives access back', async () => {
    renderAt('/admin/staff');
    const row = (await screen.findByRole('rowheader', { name: /Kiprop/ })).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Suspend' }));
    expect(within(row).getByText(/Suspend Kiprop\? They are signed out of every counter at once/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Suspend' }));
    const section = (await screen.findByRole('heading', { name: 'Suspended' })).closest('section')!;
    expect(within(section).getByText('Kiprop')).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: /Kiprop/ })).toBeNull();
    expect((await db.people.get('p_kiprop'))!.suspended_at).not.toBeNull();
    expect(await screen.findByRole('rowheader', { name: /Njeri/ })).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Give access back' }));
    expect(await screen.findByRole('rowheader', { name: /Kiprop/ })).toBeInTheDocument();
    expect((await db.people.get('p_kiprop'))!.suspended_at).toBeNull();
    const kinds = (await db.auditEvents.where('ref_id').equals('p_kiprop').toArray()).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['person_suspended', 'person_reinstated']));
  });

  it('revoking a phone asks why, then greys it out', async () => {
    renderAt('/admin/staff');
    const counter2 = (await screen.findByText('Counter 2')).closest<HTMLElement>('.a-device')!;
    await user.click(within(counter2).getByRole('button', { name: 'Revoke' }));
    await user.click(within(counter2).getByRole('button', { name: 'Revoke Counter 2' }));
    expect(await within(counter2).findByText('Revoked')).toBeInTheDocument();
    expect((await db.devices.get('d_counter2'))!.revoked_reason).toBe('Phone lost');
  });

  it('deleting a phone confirms, revokes it and takes it off the list (its row stays)', async () => {
    renderAt('/admin/staff');
    const counter2 = (await screen.findByText('Counter 2')).closest<HTMLElement>('.a-device')!;
    await user.click(within(counter2).getByRole('button', { name: 'Delete' }));
    expect(within(counter2).getByText(/It stops working at once/)).toBeInTheDocument();
    await user.click(within(counter2).getByRole('button', { name: 'Delete Counter 2' }));
    await waitFor(() => expect(screen.queryByText('Counter 2')).toBeNull());
    const row = (await db.devices.get('d_counter2'))!;
    expect(row.deleted_at).toBeTruthy();
    expect(row.revoked_at).toBeTruthy();
    expect((await db.auditEvents.where('ref_id').equals('d_counter2').toArray()).map((a) => a.kind)).toContain('device_deleted');
  });
});

describe('Audit log (R-AUD-1, R-AUD-2)', () => {
  it('is read-only and filters by kind and text', async () => {
    renderAt('/admin/audit');
    expect(await screen.findByText('Read-only. Nothing here can be changed or deleted.')).toBeInTheDocument();
    expect(screen.getByText(/Shift closed · Short KES 300/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Shifts/ }));
    expect(screen.queryByText(/Order #048/)).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Shifts/ }));
    await user.type(screen.getByRole('searchbox'), '#048');
    expect(await screen.findByText(/Order #048 Counter recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/Shift closed/)).toBeNull();
    expect(screen.queryAllByRole('button', { name: /delete|edit/i })).toHaveLength(0);
  });
});
