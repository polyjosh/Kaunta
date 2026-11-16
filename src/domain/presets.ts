import { loadSeed } from './seed';
import type { Category, Product, ProductSize } from './types';

/**
 * First run (Components.dc.html → "First run · admin"): common Kenyan drinks
 * and food a new bar can start from, in the design's order. They are the
 * handoff seed's products with its sizes and placeholder prices; the admin
 * sets real prices afterwards in the product editor.
 */
export const PRESET_IDS = [
  'tusker',
  'whitecap',
  'guinness',
  'pilsner',
  'smirnoff',
  'cane',
  'gilbeys',
  'hunters',
  'keg',
  'soda',
  'water',
  'nyama',
] as const;

export type PresetId = (typeof PRESET_IDS)[number];

export interface Preset {
  id: PresetId;
  product: Product;
  sizes: ProductSize[];
}

/** The categories every bar starts with (also inserted by the server migration). */
export function defaultCategories(): Category[] {
  return loadSeed().categories;
}

/**
 * Each preset as a new product for one bar: nothing on the shelf yet (0), or
 * not tracked on the shelf for food and kegs (null, R-STOCK-1). Ids are the
 * bar's id and the seed's ("<bar>:tusker"): unique across the bars on one
 * server, and the same for two admins of one bar adding them at once, so that
 * is still one product.
 */
export function presets(barId: string): Preset[] {
  const seed = loadSeed();
  const scoped = (id: string) => `${barId}:${id}`;
  return PRESET_IDS.map((id) => {
    const p = seed.products.find((x) => x.id === id);
    if (!p) throw new Error(`Preset ${id} is not in the seed`);
    const untracked = p.category_id === 'food' || p.category_id === 'keg';
    return {
      id,
      product: { ...p, id: scoped(id), stock_qty: untracked ? null : 0, manual_out_of_stock: false, archived_at: null },
      sizes: seed.sizes.filter((s) => s.product_id === id).map((s) => ({ ...s, id: scoped(s.id), product_id: scoped(id), enabled: true })),
    };
  });
}
