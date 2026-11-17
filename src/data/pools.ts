import { isPerSize, stockedSizes, stockPool } from '../domain/stock';
import type { Id } from '../domain/types';
import type { KauntaDB } from './db';

/**
 * Moves stock of a product by `delta` units or ml, into or out of the right
 * size's stock when the product keeps stock per size (a sale of a tot comes
 * out of the bottle it is poured from). The product's total moves with it.
 * Returns the size whose stock moved (null = the one pool), or undefined when
 * the product is not counted on the shelf. Mirrors adjust_stock() on the server.
 */
export async function shiftStock(db: KauntaDB, product_id: Id, size_id: Id | null | undefined, delta: number): Promise<Id | null | undefined> {
  const product = await db.products.get(product_id);
  if (!product || product.stock_qty === null) return undefined;
  let pool: Id | null = null;
  if (isPerSize(product)) {
    const sizes = await db.sizes.where('product_id').equals(product_id).toArray();
    const size = sizes.find((s) => s.id === size_id);
    const target = sizes.find((s) => s.id === (size ? stockPool(product, size) : null)) ?? stockedSizes(product, sizes)[0];
    if (target) {
      pool = target.id;
      await db.sizes.update(target.id, { stock_qty: (target.stock_qty ?? 0) + delta });
    }
  }
  await db.products.update(product_id, { stock_qty: product.stock_qty + delta });
  return pool;
}
