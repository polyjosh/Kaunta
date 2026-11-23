import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { KauntaDB } from '../data/db';
import { DbProvider } from '../data/react';
import { loadReceipt } from '../data/receipt';
import { seedDatabase } from '../data/seedDb';
import { I18nProvider } from '../lib/I18nProvider';
import { OrderDetailScreen } from './OrderDetailScreen';
import { ReceiptProvider, receiptPageCss, receiptTime } from './Receipt';
import { SellScreen } from './SellScreen';
import { SessionProvider } from './Session';

let db: KauntaDB;
let n = 0;
let print: ReturnType<typeof vi.fn>;
const user = userEvent.setup();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T19:20:00.000Z'));
  db = new KauntaDB(`kaunta-receipt-${++n}`);
  await seedDatabase(db);
  print = vi.fn();
  window.print = print as unknown as () => void;
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
            <ReceiptProvider>
              <Routes>
                <Route path="/counter/sell" element={<SellScreen />} />
                <Route path="/counter/orders/:id" element={<OrderDetailScreen />} />
              </Routes>
            </ReceiptProvider>
          </SessionProvider>
        </DbProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('loadReceipt', () => {
  it('has the order, its lines, who served and recorded it, payments and what is left', async () => {
    const r = (await loadReceipt(db, 'o_044'))!;
    expect(r).toMatchObject({ bar_name: 'Baraka Pub', short_no: '#044', label: 'Table 9', server: 'Kiprop', total_kes: 1250, paid_kes: 400, due_kes: 850, voided: false });
    expect(r.lines.reduce((sum, l) => sum + l.total_kes, 0)).toBe(1250);
    expect(r.payments).toHaveLength(1);
  });

  it('dates in Nairobi time', () => {
    expect(receiptTime('2026-11-10T19:08:00.000Z', 'en')).toBe('10 Nov 2026 22:08');
  });
});

describe('printing receipts', () => {
  it('prints after Record (pay later), with the server and the items', async () => {
    renderAt('/counter/sell');
    await user.click(await screen.findByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Record (pay later)' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const receipt = within(screen.getByTestId('receipt'));
    expect(receipt.getByText('Wanjiku')).toBeInTheDocument();
    expect(receipt.getByText(/Tusker Lager/)).toBeInTheDocument();
    expect(receipt.getByText('To pay')).toBeInTheDocument();
  });

  it('prints after Record & paid, marked paid in full', async () => {
    renderAt('/counter/sell');
    await user.click(await screen.findByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Record & paid' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Cash/ }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const receipt = within(screen.getByTestId('receipt'));
    expect(receipt.getByText('Paid in full')).toBeInTheDocument();
    expect(receipt.getAllByText('KES 300').length).toBeGreaterThan(0);
  });

  it('does not print after a sale when this phone has receipts turned off', async () => {
    localStorage.setItem('kaunta.printReceipts', 'off');
    renderAt('/counter/sell');
    await user.click(await screen.findByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Record (pay later)' }));
    await screen.findByText(/recorded/);
    expect(print).not.toHaveBeenCalled();
  });

  it('Print receipt on an order prints it again later', async () => {
    renderAt('/counter/orders/o_044');
    await user.click(await screen.findByRole('button', { name: 'Print receipt' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const receipt = within(screen.getByTestId('receipt'));
    expect(receipt.getByText('Kiprop')).toBeInTheDocument();
    expect(receipt.getByText('Balance to pay')).toBeInTheDocument();
    expect(receipt.getByText('KES 850')).toBeInTheDocument();
  });
});

describe('the page fits the receipt (roll printers stop at the last line)', () => {
  it('is as wide as the roll and as long as the receipt, plus a short tail', () => {
    // 96 px = 1 inch = 25.4 mm.
    expect(receiptPageCss(80, 960)).toBe('@page { size: 80mm 258mm; margin: 0; }');
    expect(receiptPageCss(58, 384)).toBe('@page { size: 58mm 106mm; margin: 0; }');
    // Never a sliver of a page.
    expect(receiptPageCss(80, 0)).toBe('@page { size: 80mm 30mm; margin: 0; }');
  });

  it('sets the page before printing, at this phone’s paper width', async () => {
    renderAt('/counter/orders/o_044');
    await user.click(await screen.findByRole('button', { name: 'Print receipt' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(document.getElementById('k-receipt-page')?.textContent).toContain('size: 80mm');

    localStorage.setItem('kaunta.paperWidth', '58');
    await user.click(screen.getByRole('button', { name: 'Print receipt' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    expect(document.getElementById('k-receipt-page')?.textContent).toContain('size: 58mm');
  });
});
