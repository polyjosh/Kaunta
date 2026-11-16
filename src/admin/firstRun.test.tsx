import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { KauntaDB } from '../data/db';
import { defaultCategories, PRESET_IDS, presets } from '../domain/presets';
import { loadSeed } from '../domain/seed';
import { I18nProvider } from '../lib/I18nProvider';
import type { Locale } from '../lib/i18n';
import { ThemeProvider } from '../lib/ThemeProvider';
import { AdminApp } from './AdminApp';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();

/** A new bar: the bar, its owner and the categories, but no products yet. */
beforeEach(async () => {
  db = new KauntaDB(`kaunta-first-run-${++n}`);
  const seed = loadSeed();
  await db.bar.add(seed.bar);
  await db.people.bulkAdd(seed.people.filter((p) => p.role === 'owner'));
  await db.categories.bulkAdd(defaultCategories());
  // Marked as filled, so the demo does not load the sample night over it.
  await db.meta.add({ key: 'seeded', value: new Date().toISOString() });
});
afterEach(async () => {
  await db.delete();
});

function renderAt(path: string, locale: Locale = 'en') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider initialLocale={locale}>
        <ThemeProvider>
          <Routes>
            <Route path="/admin/*" element={<AdminApp db={db} config={null} />} />
          </Routes>
        </ThemeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('presets', () => {
  it('are the design’s twelve, with the seed’s sizes and prices, and an empty shelf', () => {
    const all = presets('bar_new');
    expect(all.map((p) => p.product.name)).toEqual([
      'Tusker Lager', 'White Cap', 'Guinness', 'Pilsner', 'Smirnoff Vodka', 'Kenya Cane',
      'Gilbey’s Gin', 'Hunter’s Choice', 'Keg lager', 'Soda', 'Water', 'Nyama choma',
    ]);
    const cane = all.find((p) => p.id === 'cane')!;
    expect(cane.product.id).toBe('bar_new:cane');
    expect(cane.sizes.every((s) => s.product_id === 'bar_new:cane' && s.id.startsWith('bar_new:'))).toBe(true);
    expect(cane.product.stock_mode).toBe('ml');
    expect(cane.sizes.map((s) => [s.label_en, s.deduct, s.price_kes])).toEqual([
      ['Tot', 30, 80], ['250ml', 250, 350], ['350ml', 350, 450], ['750ml', 750, 900], ['1 Litre', 1000, 1200],
    ]);
    for (const p of all) {
      // Nothing delivered yet; food and kegs are not counted on the shelf (R-STOCK-1).
      expect(p.product.stock_qty).toBe(['keg', 'food'].includes(p.product.category_id) ? null : 0);
      expect(p.product.archived_at).toBeNull();
      expect(p.sizes.length).toBeGreaterThan(0);
      expect(p.sizes.every((s) => s.product_id === p.product.id && Number.isSafeInteger(s.price_kes) && s.price_kes > 0)).toBe(true);
    }
    expect(new Set(all.map((p) => p.product.category_id))).toEqual(new Set(defaultCategories().map((c) => c.id)));
  });
});

describe('first run, no products', () => {
  it('Today offers the presets, all ticked', async () => {
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'No products yet' })).toBeInTheDocument();
    expect(screen.getByText(/Start with common Kenyan drinks and food/)).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(PRESET_IDS.length);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: 'Add 12 products' })).toBeEnabled();
    // Nothing to report on a bar with nothing to sell.
    expect(screen.queryByText('Did I lose money today?')).not.toBeInTheDocument();
  });

  it('adds what stays ticked, each as an audited, queued product change', async () => {
    renderAt('/admin/products');
    await user.click(await screen.findByRole('checkbox', { name: 'Smirnoff Vodka' }));
    await user.click(screen.getByRole('button', { name: 'Add 11 products' }));

    // The product list, by category.
    const spirits = await screen.findByRole('region', { name: 'Spirits' });
    expect(within(spirits).getByText('Kenya Cane')).toBeInTheDocument();
    expect(within(spirits).queryByText('Smirnoff Vodka')).not.toBeInTheDocument();
    const beer = screen.getByRole('region', { name: 'Beer' });
    expect(within(beer).getByText('Guinness').closest('a')).toHaveTextContent('500ml · KES 330');
    // Nothing on the shelf yet: shown as low, which still sells (R-SELL-2).
    expect(within(beer).getByText('Guinness').closest('a')).toHaveTextContent('0 bottles');

    expect(await db.products.count()).toBe(11);
    const outbox = await db.adminOutbox.toArray();
    expect(outbox).toHaveLength(11);
    expect(outbox.every((e) => e.type === 'product_saved' && e.status === 'pending' && e.payload.before === null)).toBe(true);
    expect(await db.auditEvents.where('kind').equals('product_saved').count()).toBe(11);
    expect((await db.products.get('bar_baraka:keg'))?.stock_qty).toBeNull();
    expect((await db.products.get('bar_baraka:tusker'))?.stock_qty).toBe(0);
  });

  it('the count follows the ticks, and nothing ticked adds nothing', async () => {
    renderAt('/admin/products');
    const boxes = await screen.findAllByRole('checkbox');
    for (const box of boxes.slice(1)) await user.click(box);
    expect(screen.getByRole('button', { name: 'Add 1 product' })).toBeEnabled();
    await user.click(boxes[0]!);
    expect(screen.getByRole('button', { name: 'Add 0 products' })).toBeDisabled();
  });

  it('“Start from blank” opens a new product', async () => {
    renderAt('/admin/products');
    await user.click(await screen.findByRole('button', { name: 'Start from blank' }));
    expect(await screen.findByRole('heading', { name: 'New product' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveDisplayValue('Beer');
  });

  it('reads in Kiswahili', async () => {
    renderAt('/admin', 'sw');
    expect(await screen.findByRole('heading', { name: 'Bado hakuna bidhaa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ongeza bidhaa 12' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anza bila kitu' })).toBeInTheDocument();
  });
});
