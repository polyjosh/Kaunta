import type { TFunction } from '../lib/I18nProvider';
import type { Locale } from '../lib/i18n';
import type { Product, ProductSize } from '../domain/types';

/** Where an order is going. Null = no table chosen. */
export type TableChoice = `${number}` | 'counter' | 'takeaway' | null;

/**
 * Orders store their label in one canonical form ("Table 4", "Counter",
 * "Takeaway", "" for none, or a free nickname like "Mzee in blue"), so the
 * same order reads correctly in either language.
 */
export function labelForTable(table: TableChoice): string {
  if (table === null) return '';
  if (table === 'counter') return 'Counter';
  if (table === 'takeaway') return 'Takeaway';
  return `Table ${table}`;
}

export function displayLabel(label: string, t: TFunction): string {
  const table = /^Table (\d+)$/.exec(label);
  if (table) return t('sell.table', { n: table[1]! });
  if (label === 'Counter') return t('sell.counter');
  if (label === 'Takeaway') return t('sell.takeaway');
  if (label === '') return t('sell.noTable');
  return label;
}

export function productName(product: Pick<Product, 'name' | 'name_sw'>, locale: Locale): string {
  return (locale === 'sw' && product.name_sw) || product.name;
}

export function sizeLabel(size: Pick<ProductSize, 'label_en' | 'label_sw'>, locale: Locale): string {
  return locale === 'sw' ? size.label_sw : size.label_en;
}

/** Search matches the English or the Kiswahili name, whatever language is showing. */
export function matchesSearch(product: Pick<Product, 'name' | 'name_sw'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  return product.name.toLowerCase().includes(q) || (product.name_sw ?? '').toLowerCase().includes(q);
}
