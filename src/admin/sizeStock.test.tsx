import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { recordOrder } from '../data/commands';
import { seedAdminDatabase } from '../data/adminSeed';
import { KauntaDB } from '../data/db';
import { seedDatabase } from '../data/seedDb';
import { SAMPLE_NOW } from '../domain/sampleDay';
import { I18nProvider } from '../lib/I18nProvider';
import { ThemeProvider } from '../lib/ThemeProvider';
import { AdminApp } from './AdminApp';

/**
 * Stock per size: 250 ml and 750 ml Smirnoff are delivered, counted and sold
 * from their own stock; a tot is poured from the 750 ml bottle.
 */

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SAMPLE_NOW));
  db = new KauntaDB(`kaunta-size-stock-${++n}`);
  await seedAdminDatabase(db, { now: new Date(SAMPLE_NOW) });
});
afterEach(async () => {
  vi.useRealTimers();
  await db.delete();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider initialLocale="en">
        <ThemeProvider>
          <Routes>
            <Route path="/admin/*" element={<AdminApp db={db} />} />
          </Routes>
        </ThemeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

/** Smirnoff with stock per size: `ml250` on the 250s, the rest on the 750s, tots from the 750s. */
async function perSize(store: KauntaDB, ml250: number) {
  const total = (await store.products.get('smirnoff'))!.stock_qty!;
  await store.products.update('smirnoff', { per_size: true });
  await store.sizes.update('smirnoff_0', { stock_from: 'smirnoff_2', stock_qty: null });
  await store.sizes.update('smirnoff_1', { stock_qty: ml250 });
  await store.sizes.update('smirnoff_2', { stock_qty: total - ml250 });
  return total;
}

const sizeStock = async (store: KauntaDB, id: string) => (await store.sizes.get(id))!.stock_qty;

describe('Stock per size', () => {
  it('is switched on in the product; each size is then counted and warned about on its own', async () => {
    const total = (await db.products.get('smirnoff'))!.stock_qty!;
    renderAt('/admin/products/smirnoff');
    await user.click(await screen.findByRole('switch', { name: "Keep each size's stock apart" }));
    // A tot is poured from the largest bottle to start with.
    expect(screen.getByLabelText('Where Tot is taken from')).toHaveDisplayValue('From 750ml');
    expect(screen.getByLabelText('Where 250ml is taken from')).toHaveDisplayValue('Its own');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const card = (await screen.findByRole('heading', { name: 'In stock, by size' })).closest('section')!;
    // Until counted, it is all on the 750s; the total did not change.
    expect(await sizeStock(db, 'smirnoff_2')).toBe(total);
    expect(await sizeStock(db, 'smirnoff_1')).toBe(0);
    expect(await sizeStock(db, 'smirnoff_0')).toBeNull();
    expect(within(card).getByText('Tot poured from this')).toBeInTheDocument();

    // Each size's stock is typed in ml (spirits) and saved as a count.
    const the250 = within(card).getByLabelText('250ml in stock now');
    await user.clear(the250);
    await user.type(the250, '1500');
    expect(within(card).getByText('6 bottles')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Save stock' }));
    expect(await within(card).findByText('6 bottles', { selector: '.a-sizestock-qty' })).toBeInTheDocument();
    expect(await sizeStock(db, 'smirnoff_1')).toBe(1500);
    expect((await db.products.get('smirnoff'))!.stock_qty).toBe(total + 1500);
    const movement = (await db.stockMovements.where('product_id').equals('smirnoff').toArray()).find((m) => m.reason === 'count');
    expect(movement).toMatchObject({ size_id: 'smirnoff_1', delta: 1500 });

    // Warn at 8 bottles of 250 ml: stored in ml, shown as Low.
    const warn = within(card).getByLabelText('Warn when 250ml is at or below');
    await user.type(warn, '8');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await within(card).findByText('Low')).toBeInTheDocument();
    expect((await db.sizes.get('smirnoff_1'))!.low_stock_at).toBe(2000);
  });

  it('a delivery of 250 ml bottles goes to the 250s only', async () => {
    await perSize(db, 500);
    const the750 = await sizeStock(db, 'smirnoff_2');
    renderAt('/admin/stock/new?product=smirnoff');
    await user.selectOptions(await screen.findByLabelText('How Smirnoff Vodka arrived'), '250ml bottle');
    const qty = screen.getByLabelText('How many: 250ml bottle, Smirnoff Vodka');
    await user.clear(qty);
    await user.type(qty, '4');
    expect(screen.getByText(/Now 500 → 1,500 ml/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add to stock' }));
    expect(await screen.findByText(/Added to stock: 1 product/)).toBeInTheDocument();
    expect(await sizeStock(db, 'smirnoff_1')).toBe(1500);
    expect(await sizeStock(db, 'smirnoff_2')).toBe(the750);
    const delivery = (await db.deliveries.toArray()).find((d) => d.lines.some((l) => l.product_id === 'smirnoff'))!;
    expect(delivery.lines[0]).toMatchObject({ size_id: 'smirnoff_1', total: 1000 });
  });

  it('Products shows each size; Today flags the one size that is below zero', async () => {
    await perSize(db, -250);
    renderAt('/admin/products');
    expect(await screen.findByText(/750ml \d+ bottles.* · 250ml −250 ml/)).toBeInTheDocument();
    cleanupAndRender('/admin');
    expect(await screen.findByText('Smirnoff Vodka 250ml is at −250 ml')).toBeInTheDocument();
  });
});

function cleanupAndRender(path: string) {
  document.body.innerHTML = '';
  renderAt(path);
}

describe('Editing the stock figure', () => {
  it('in bottles after switching from ml to count, and in ml after switching back', async () => {
    const ml = (await db.products.get('smirnoff'))!.stock_qty!;
    renderAt('/admin/products/smirnoff');
    await user.click(await screen.findByRole('radio', { name: /^Count/ }));
    // Worked out in bottles (750 ml each), never the ml figure called bottles.
    const field = screen.getByLabelText('In stock now');
    expect(field).toHaveValue(String(Math.round(ml / 750)));
    expect(screen.getByText(/Worked out from .* ml at 750 ml a bottle/)).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '5');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('5 bottles');
    expect(await db.products.get('smirnoff')).toMatchObject({ stock_mode: 'count', stock_qty: 5 });
    const count = (await db.stockMovements.where('product_id').equals('smirnoff').toArray()).find((m) => m.reason === 'count');
    expect(count).toMatchObject({ delta: 5 - ml });

    // Back to ml: suggested as 5 × 750 ml, typed as what the shelf really holds.
    await user.click(screen.getByRole('radio', { name: /^Millilitres/ }));
    expect(screen.getByLabelText('In stock now')).toHaveValue('3750');
    await user.clear(screen.getByLabelText('In stock now'));
    await user.type(screen.getByLabelText('In stock now'), '3600');
    for (const [size, mlEach] of [['Tot', '30'], ['250ml', '250'], ['750ml', '750']]) {
      const each = screen.getByLabelText(`Takes away, ${size}`);
      await user.clear(each);
      await user.type(each, mlEach!);
    }
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('3,600 ml');
    expect(await db.products.get('smirnoff')).toMatchObject({ stock_mode: 'ml', stock_qty: 3600 });
  });

  it('can be corrected without changing anything else, and must not be left empty', async () => {
    renderAt('/admin/products/pilsner');
    const field = await screen.findByLabelText('In stock now');
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Save stock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Type how much is in stock.');
    await user.type(field, '30');
    await user.click(screen.getByRole('button', { name: 'Save stock' }));
    await screen.findByText('30 bottles');
    expect((await db.products.get('pilsner'))!.stock_qty).toBe(30);
    expect(await db.auditEvents.where('kind').equals('product_saved').filter((e) => e.ref_id === 'pilsner').count()).toBe(0);
  });
});

describe('Saving next to Add stock', () => {
  it('saves any change to the product from the stock card, without scrolling back up', async () => {
    renderAt('/admin/products/pilsner');
    const price = await screen.findByLabelText('Price of 500ml');
    await user.clear(price);
    await user.type(price, '330');
    const addStock = screen.getByRole('link', { name: 'Add stock' });
    const actions = addStock.closest('.a-actions') as HTMLElement;
    await user.click(within(actions).getByRole('button', { name: 'Save product' }));
    await screen.findByText(/^Saved\./);
    expect((await db.sizes.where('product_id').equals('pilsner').first())!.price_kes).toBe(330);
    const after = screen.getByRole('link', { name: 'Add stock' }).closest('.a-actions') as HTMLElement;
    expect(within(after).queryByRole('button')).toBeNull();
  });
});

describe('Stock per size at the counter', () => {
  let counter: KauntaDB;
  beforeEach(async () => {
    counter = new KauntaDB(`kaunta-size-stock-counter-${++n}`);
    await seedDatabase(counter);
  });
  afterEach(() => counter.delete());

  it('a 250 ml sale comes out of the 250s, a tot out of the 750s, and the total follows both', async () => {
    const total = await perSize(counter, 1000);
    const ctx = { person_id: 'p_wanjiku', device_id: 'd_counter1', now: () => new Date('2026-11-10T19:43:00.000Z') };
    await recordOrder(counter, ctx, { label: 'Counter', server_id: 'p_wanjiku', items: [{ size_id: 'smirnoff_1', qty: 1 }, { size_id: 'smirnoff_0', qty: 2 }] });
    expect(await sizeStock(counter, 'smirnoff_1')).toBe(750);
    expect(await sizeStock(counter, 'smirnoff_2')).toBe(total - 1000 - 60);
    expect((await counter.products.get('smirnoff'))!.stock_qty).toBe(total - 250 - 60);
    const moves = await counter.stockMovements.where('product_id').equals('smirnoff').toArray();
    expect(moves.map((m) => [m.size_id, m.delta]).sort()).toEqual([['smirnoff_1', -250], ['smirnoff_2', -60]].sort());
  });
});
