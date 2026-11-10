import type { Id, Keg, OrderLine, ProductSize } from './types';

type KegLine = Pick<OrderLine, 'qty' | 'size_id' | 'status' | 'keg_id'>;

/** Millilitres recorded against a keg: its baseline plus every line linked to it that still counts. */
export function kegRecordedMl(
  keg: Pick<Keg, 'id' | 'recorded_ml_baseline'>,
  lines: readonly KegLine[],
  sizes: ReadonlyMap<Id, Pick<ProductSize, 'deduct'>>,
): number {
  return lines.reduce((ml, line) => {
    if (line.keg_id !== keg.id || line.status === 'voided') return ml;
    const size = sizes.get(line.size_id);
    return size ? ml + line.qty * size.deduct : ml;
  }, keg.recorded_ml_baseline);
}

/** R-KEG-2: an estimate from sales ("~31 L left"). Never below zero. */
export function kegRemainingMl(keg: Pick<Keg, 'volume_ml'>, recordedMl: number): number {
  return Math.max(0, keg.volume_ml - recordedMl);
}

export interface KegFinishSummary {
  expected_cups: number;
  recorded_cups: number;
  /** Cups that were poured but not recorded, after the foam allowance. Zero when nothing is missing. */
  short_cups: number;
  short_value_kes: number;
}

/**
 * R-KEG-3: expected = volume / cup; recorded = recorded ml / cup (a 2 L jug
 * is 4 cups); short = expected − recorded − foam allowance, valued at the mug price.
 */
export function kegFinishSummary(
  keg: Pick<Keg, 'volume_ml' | 'cup_ml'>,
  recordedMl: number,
  foamAllowanceCups: number,
  mugPriceKes: number,
): KegFinishSummary {
  const expected_cups = Math.floor(keg.volume_ml / keg.cup_ml);
  const recorded_cups = Math.floor(recordedMl / keg.cup_ml);
  const short_cups = Math.max(0, expected_cups - recorded_cups - foamAllowanceCups);
  return { expected_cups, recorded_cups, short_cups, short_value_kes: short_cups * mugPriceKes };
}

/** R-KEG-1: the next keg to tap for a product is the oldest one still queued. */
export function nextQueuedKeg<K extends Pick<Keg, 'product_id' | 'status' | 'code'>>(
  kegs: readonly K[],
  productId: Id,
): K | undefined {
  return kegs
    .filter((keg) => keg.product_id === productId && keg.status === 'queued')
    .sort((a, b) => a.code.localeCompare(b.code))[0];
}
