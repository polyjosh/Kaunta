import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { seedAdminDatabase } from '../data/adminSeed';
import { KauntaDB } from '../data/db';
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

  it('closes once every shift is closed, and keeps the difference on record', async () => {
    await db.shifts.update('s_p_akinyi', { closed_at: '2026-11-10T23:10:00.000Z', counted_cash_kes: 14_800, result_kes: 0 });
    renderAt('/admin/reconcile/2026-11-10');
    await user.type(await screen.findByLabelText('Till total in KES'), '47650');
    await user.click(screen.getByRole('button', { name: 'Close the business day' }));
    expect(await screen.findByText(/Day closed by Njeri at 02:14/)).toBeInTheDocument();
    expect(await db.dayCloses.get('2026-11-10')).toMatchObject({ till_total_kes: 47_650, recorded_mpesa_kes: 48_400, closed_by: 'p_njeri' });
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

describe('Staff & devices (R-PIN-1, R-PIN-2, R-DEV-2)', () => {
  it('unlocks a locked person', async () => {
    renderAt('/admin/staff');
    const row = (await screen.findByRole('rowheader', { name: /Otieno/ })).closest('tr')!;
    expect(within(row).getByText(/PIN locked · 4:5\d/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Unlock' }));
    expect(await within(row).findByText('PIN')).toBeInTheDocument();
    expect((await db.people.get('p_otieno'))!.pin_locked_until).toBeNull();
  });

  it('a PIN reset shows a one-time code once and stores only its hash', async () => {
    renderAt('/admin/staff');
    const row = (await screen.findByRole('rowheader', { name: /Wanjiku/ })).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Reset PIN' }));
    const notice = (await screen.findByRole('heading', { name: 'One-time code for Wanjiku' })).closest<HTMLElement>('[role="status"]')!;
    const code = within(notice).getByText(/^\d{3} \d{3}$/).textContent!.replace(' ', '');
    const wanjiku = (await db.people.get('p_wanjiku'))!;
    expect(wanjiku.pin_reset_hash).toMatch(/^pbkdf2-sha256\$/);
    expect(wanjiku.pin_reset_hash).not.toContain(code);
  });

  it('revoking a phone asks why, then greys it out', async () => {
    renderAt('/admin/staff');
    const counter2 = (await screen.findByText('Counter 2')).closest<HTMLElement>('.a-device')!;
    await user.click(within(counter2).getByRole('button', { name: 'Revoke' }));
    await user.click(within(counter2).getByRole('button', { name: 'Revoke Counter 2' }));
    expect(await within(counter2).findByText('Revoked')).toBeInTheDocument();
    expect((await db.devices.get('d_counter2'))!.revoked_reason).toBe('Phone lost');
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
