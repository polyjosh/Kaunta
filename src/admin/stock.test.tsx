import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { seedAdminDatabase } from '../data/adminSeed';
import { KauntaDB } from '../data/db';
import { SAMPLE_NOW } from '../domain/sampleDay';
import { I18nProvider } from '../lib/I18nProvider';
import { ThemeProvider } from '../lib/ThemeProvider';
import { AdminApp } from './AdminApp';

/**
 * Adding stock: quantities typed or stepped, lines removed before saving,
 * the packs a product arrives in (kept on the product), sizes removed from a
 * product, and the warning level in the unit of the chosen counting method.
 */

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SAMPLE_NOW));
  db = new KauntaDB(`kaunta-stock-ui-${++n}`);
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

describe('Add stock', () => {
  it('the number can be typed, and + still adds one', async () => {
    renderAt('/admin/stock/new?product=pilsner');
    await user.selectOptions(await screen.findByLabelText('How Pilsner arrived'), 'Single bottle or piece');
    const qty = screen.getByLabelText('How many: Single bottle or piece, Pilsner');
    await user.clear(qty);
    await user.type(qty, '17');
    expect(screen.getByText('Now −4 → 13 bottles')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'One more Single bottle or piece' }));
    expect(qty).toHaveValue('18');
    await user.click(screen.getByRole('button', { name: 'Add to stock' }));
    expect(await screen.findByText(/Added to stock: 1 product/)).toBeInTheDocument();
    expect((await db.products.get('pilsner'))!.stock_qty).toBe(14);
  });

  it('a line can be removed before adding to stock', async () => {
    renderAt('/admin/stock/new?product=pilsner');
    await user.click(await screen.findByRole('button', { name: '+ Add a product' }));
    await user.selectOptions(screen.getByLabelText('Which product?'), 'Tusker Lager');
    expect(await screen.findByLabelText('How Tusker Lager arrived')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Pilsner from this delivery' }));
    expect(screen.queryByLabelText('How Pilsner arrived')).toBeNull();
    const tuskerBefore = (await db.products.get('tusker'))!.stock_qty!;
    await user.click(screen.getByRole('button', { name: 'Add to stock' }));
    expect(await screen.findByText(/Added to stock: 1 product/)).toBeInTheDocument();
    expect((await db.products.get('pilsner'))!.stock_qty).toBe(-4);
    expect((await db.products.get('tusker'))!.stock_qty).toBe(tuskerBefore + 25);
  });

  it('a new pack size can be added while entering a delivery, and is kept on the product', async () => {
    renderAt('/admin/stock/new?product=pilsner');
    await user.selectOptions(await screen.findByLabelText('How Pilsner arrived'), '+ Another pack size…');
    await user.type(screen.getByLabelText('Pack'), 'Box of 12');
    await user.type(screen.getByLabelText('Bottles or pieces in one'), '12');
    await user.click(screen.getByRole('button', { name: 'Save pack' }));
    expect(await screen.findByText('Now −4 → 8 bottles')).toBeInTheDocument();
    expect(screen.getByLabelText('How Pilsner arrived')).toHaveDisplayValue('Box of 12');
    const packs = (await db.products.get('pilsner'))!.packs!;
    expect(packs.map((p) => [p.label, p.count])).toEqual([['Crate of 24', 24], ['Crate of 25', 25], ['Box of 12', 12]]);
  });

  it('spirits can arrive in boxes of a bottle size', async () => {
    await db.products.update('smirnoff', { packs: [{ id: 'box', label: 'Box of 12', count: 12, size_id: 'smirnoff_2' }] });
    renderAt('/admin/stock/new?product=smirnoff');
    await user.selectOptions(await screen.findByLabelText('How Smirnoff Vodka arrived'), 'Box of 12 (12 × 750ml)');
    expect(screen.getByText('= 9 L (9,000 ml)')).toBeInTheDocument();
  });
});

describe('Product: sizes, packs and the warning level', () => {
  it('a size can be removed; it stops being sold and past sales keep it', async () => {
    renderAt('/admin/products/soda');
    await user.click(await screen.findByRole('button', { name: 'Remove size 300ml' }));
    expect(screen.getByText(/Removed when you save: 300ml/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Saved\. Counters get the change/)).toBeInTheDocument();
    expect(await db.sizes.get('soda_0')).toMatchObject({ enabled: false, archived_at: expect.any(String) });
    expect(screen.queryByLabelText('Price of 300ml')).toBeNull();
  });

  it('a size just added can be removed again before saving', async () => {
    renderAt('/admin/products/tusker');
    await user.click(await screen.findByRole('button', { name: '+ Add a size' }));
    expect(screen.getAllByRole('button', { name: /^Remove size/ })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Remove size new size' }));
    expect(screen.getAllByRole('button', { name: /^Remove size/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('the packs it is delivered in can be added, changed and removed', async () => {
    renderAt('/admin/products/tusker');
    await user.click(await screen.findByRole('button', { name: 'Remove Crate of 24' }));
    await user.click(screen.getByRole('button', { name: '+ Add a pack' }));
    await user.type(screen.getByLabelText('Name of pack 2'), 'Six-pack');
    await user.type(screen.getByLabelText('Bottles or pieces in Six-pack'), '6');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Saved\. Counters get the change/)).toBeInTheDocument();
    expect((await db.products.get('tusker'))!.packs!.map((p) => [p.label, p.count])).toEqual([['Crate of 25', 25], ['Six-pack', 6]]);
  });

  it('a pack needs a name and a number', async () => {
    renderAt('/admin/products/tusker');
    await user.click(await screen.findByRole('button', { name: '+ Add a pack' }));
    await user.type(screen.getByLabelText('Name of pack 3'), 'Box');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Each pack needs a name and how many it holds');
  });

  it('the warning level follows the counting method: shelf count in bottles for Count', async () => {
    renderAt('/admin/products/smirnoff');
    expect(await screen.findByLabelText('Warn when stock is at or below')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /^Count/ }));
    const alert = screen.getByLabelText('Warn when the shelf count is at or below');
    expect(alert).toHaveValue('');
    expect(screen.getByText(/Bottles or pieces on the shelf/)).toBeInTheDocument();
    await user.type(alert, '6');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Saved\. Counters get the change/)).toBeInTheDocument();
    expect(await db.products.get('smirnoff')).toMatchObject({ stock_mode: 'count', low_stock_at: 6 });
  });

  it('a new product can have its warning level set before it is saved', async () => {
    renderAt('/admin/products/new');
    expect(await screen.findByLabelText('Warn when the shelf count is at or below')).toBeInTheDocument();
  });
});
