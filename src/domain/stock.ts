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

/** R-STOCK-3: flagged on Today until a delivery or count brings it back to zero or above. */
export function isNegativeStock(product: Pick<Product, 'stock_qty'>): boolean {
  return product.stock_qty !== null && product.stock_qty < 0;
}

/** R-STOCK-2: deliveries are entered as containers (3 × 750 ml = 2,250 ml). */
export function deliveryTotal(containerQty: number, perContainer: number): number {
  return containerQty * perContainer;
}

/** Enabled sizes in counter order; one size = tap adds it, several = size picker (R-SELL-1). */
export function enabledSizes<S extends Pick<ProductSize, 'enabled' | 'sort'>>(sizes: readonly S[]): S[] {
  return sizes.filter((size) => size.enabled).sort((a, b) => a.sort - b.sort);
}
