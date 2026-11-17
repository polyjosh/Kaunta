import type { Product, ProductSize } from './types';

type StockView = Pick<Product, 'stock_mode' | 'stock_qty' | 'low_stock_at'>;

/** R-STOCK-1: a sale takes `size.deduct` units (count mode) or ml (ml mode) × qty from the one pool. */
export function saleDeduction(size: Pick<ProductSize, 'deduct'>, qty: number): number {
  return size.deduct * qty;
}

/** Whether the shelf is counted at all. Food and kegs are not (kegs use the keg queue, R-STOCK-4). */
export function isStockTracked(product: Pick<Product, 'stock_qty'>): boolean {
  return product.stock_qty !== null;
}

/**
 * R-SELL-2: only the manual switch blocks selling. Stock at or below zero
 * never does, because the shelf count may be the thing that is wrong.
 */
export function isSellable(product: Pick<Product, 'manual_out_of_stock' | 'archived_at'>): boolean {
  return !product.manual_out_of_stock && product.archived_at === null;
}

/** R-SELL-6: "3 left" on the tile, count mode only. */
export function isLowStock(product: StockView): boolean {
  return (
    product.stock_mode === 'count' &&
    product.stock_qty !== null &&
    product.low_stock_at !== null &&
    product.stock_qty <= product.low_stock_at
  );
}

/** At or below the owner's warning level, in either mode (admin's "Low"; the counter's "3 left" is count mode only). */
export function isBelowAlert(product: StockView): boolean {
  return product.stock_qty !== null && product.low_stock_at !== null && product.stock_qty <= product.low_stock_at;
}

/** R-STOCK-3: flagged on Today until a delivery or count brings it back to zero or above. */
export function isNegativeStock(product: Pick<Product, 'stock_qty'>): boolean {
  return product.stock_qty !== null && product.stock_qty < 0;
}

/** R-STOCK-2: deliveries are entered as containers (3 × 750 ml = 2,250 ml). */
export function deliveryTotal(containerQty: number, perContainer: number): number {
  return containerQty * perContainer;
}

/** Enabled sizes in counter order; one size = tap adds it, several = size picker (R-SELL-1). */
export function enabledSizes<S extends Pick<ProductSize, 'enabled' | 'sort' | 'archived_at'>>(sizes: readonly S[]): S[] {
  return sizes.filter((size) => size.enabled && !size.archived_at).sort((a, b) => a.sort - b.sort);
}

/* ---- Stock per size (asked for after owners add managers) ----------------
 * A product can keep each size's stock apart: 250 ml and 750 ml Smirnoff are
 * counted, delivered and sold from their own stock. A size can instead be
 * poured from another size (a tot from the 750 ml bottle). The product's
 * `stock_qty` stays the sum of its sizes' stock, so totals elsewhere hold.
 */

type PoolProduct = Pick<Product, 'per_size' | 'stock_qty'>;
type PoolSize = Pick<ProductSize, 'id' | 'product_id' | 'deduct' | 'sort' | 'archived_at' | 'stock_from' | 'stock_qty' | 'low_stock_at'>;

export const isPerSize = (product: PoolProduct): boolean => product.per_size === true && product.stock_qty !== null;

/** The size whose stock a sale of `size` comes out of; null = the product's one pool. */
export function stockPool(product: PoolProduct, size: Pick<ProductSize, 'id' | 'stock_from'>): string | null {
  return isPerSize(product) ? (size.stock_from ?? size.id) : null;
}

/** Sizes that keep their own stock (not removed, not poured from another), largest first. */
export function stockedSizes<S extends PoolSize>(product: Pick<Product, 'id'>, sizes: readonly S[]): S[] {
  return sizes
    .filter((s) => s.product_id === product.id && !s.archived_at && !s.stock_from)
    .sort((a, b) => b.deduct - a.deduct || a.sort - b.sort);
}

/** A size at or below its own warning level (per-size stock). */
export function isSizeLow(size: Pick<ProductSize, 'stock_qty' | 'low_stock_at'>): boolean {
  return size.stock_qty != null && size.low_stock_at != null && size.stock_qty <= size.low_stock_at;
}

/** Sizes with their own stock below zero (per-size), or the product's pool (one pool). */
export function negativePools<S extends PoolSize>(product: Product, sizes: readonly S[]): { size: S | null; qty: number }[] {
  if (product.stock_qty === null) return [];
  if (!isPerSize(product)) return product.stock_qty < 0 ? [{ size: null, qty: product.stock_qty }] : [];
  return stockedSizes(product, sizes).filter((s) => (s.stock_qty ?? 0) < 0).map((s) => ({ size: s, qty: s.stock_qty! }));
}

/** Admin's "Low" with per-size stock: any size at or below its own level. */
export function isProductLow<S extends PoolSize>(product: Product, sizes: readonly S[]): boolean {
  return isPerSize(product) ? stockedSizes(product, sizes).some(isSizeLow) : isBelowAlert(product);
}

/** The counter's "3 left" for a size: count mode, at or below its level, and some left. Null otherwise. */
export function leftOf<S extends PoolSize>(product: Product, size: S, sizes: readonly S[]): number | null {
  if (product.stock_mode !== 'count') return null;
  if (!isPerSize(product)) return isLowStock(product) && (product.stock_qty ?? 0) > 0 ? product.stock_qty : null;
  const pool = sizes.find((s) => s.id === stockPool(product, size));
  return pool && isSizeLow(pool) && (pool.stock_qty ?? 0) > 0 ? pool.stock_qty! : null;
}

/**
 * After a product is saved: the stock each size now holds. The product's total
 * never changes here. Sizes keep their stock; stock of a size that no longer
 * has its own (removed, now poured, or the first switch to per-size) goes to
 * the largest size, to be put right with a shelf count.
 */
export function rebalancePools<S extends PoolSize>(product: PoolProduct & Pick<Product, 'id'>, wasPerSize: boolean, sizes: readonly S[], previous: readonly PoolSize[]): S[] {
  if (!isPerSize(product)) return sizes.map((s) => ({ ...s, stock_qty: null }));
  const pools = stockedSizes(product, sizes);
  const before = new Map(previous.map((s) => [s.id, s.stock_qty ?? 0]));
  const qty = new Map(pools.map((s) => [s.id, wasPerSize ? (before.get(s.id) ?? 0) : 0]));
  const rest = product.stock_qty! - [...qty.values()].reduce((a, b) => a + b, 0);
  if (pools[0]) qty.set(pools[0].id, qty.get(pools[0].id)! + rest);
  return sizes.map((s) => ({ ...s, stock_qty: qty.has(s.id) ? qty.get(s.id)! : null }));
}
