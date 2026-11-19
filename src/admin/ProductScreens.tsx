import { useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { StatusChip } from '../components/StatusChip';
import { productName, sizeLabel } from '../counter/labels';
import { recordAdminEvent } from '../data/adminEvents';
import { useDb, useQuery } from '../data/react';
import { uuidv7 } from '../domain/ids';
import { enabledSizes, isNegativeStock, isPerSize, isProductLow, isSizeLow, negativePools, stockedSizes } from '../domain/stock';
import type { Category, Pack, Product, ProductSize, StockMode } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import type { TFunction } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import { AdminLayout, PageTitle } from './AdminLayout';
import { FirstRun } from './FirstRun';
import { useAdmin, visibleTo } from './AdminSession';
import { hhmm, personName } from './data';
import { parseKes } from './ReconcileScreen';
import { defaultPacks, isKegProduct, packsOf } from './StockScreen';

/** "4,850 ml", "24 bottles", "−4 bottles" (a count, so it may be negative). */
export function stockText(product: Pick<Product, 'stock_mode' | 'stock_qty'>, t: TFunction): string {
  if (product.stock_qty === null) return t('admin.product.notTracked');
  const n = product.stock_qty;
  const abs = formatAmount(Math.abs(n));
  return `${n < 0 ? '−' : ''}${abs} ${product.stock_mode === 'ml' ? 'ml' : t('admin.unit.bottles')}`;
}

/** One size's own stock: "6 bottles", "4 bottles + 300 ml" (ml mode, in bottles of that size), "−2 bottles". */
export function sizeStockText(mode: StockMode, qty: number, deduct: number, t: TFunction): string {
  if (mode === 'count' || qty < 0) return stockText({ stock_mode: mode, stock_qty: qty }, t);
  const full = Math.floor(qty / deduct);
  const rest = qty - full * deduct;
  return rest === 0 ? t('admin.size.bottles', { n: formatAmount(full) }) : t('admin.size.bottlesOpen', { n: formatAmount(full), ml: formatAmount(rest) });
}

/** Products' stock column: one pool, or each size's ("750ml 4 bottles · 250ml 6 bottles"). */
export function productStockText(product: Product, sizes: readonly ProductSize[], t: TFunction, locale: 'en' | 'sw'): string {
  if (!isPerSize(product)) return stockText(product, t);
  return stockedSizes(product, sizes.filter((s) => s.product_id === product.id))
    .map((s) => `${sizeLabel(s, locale)} ${sizeStockText(product.stock_mode, s.stock_qty ?? 0, s.deduct, t)}`)
    .join(' · ');
}

function categoryName(c: Category | undefined, locale: 'en' | 'sw'): string {
  return c ? (locale === 'sw' ? c.name_sw : c.name_en) : '';
}

/** Products, by category (the nav's "Products"; the editor is Product.dc.html). */
export function ProductsScreen() {
  const { t, locale } = useI18n();
  const data = useQuery(async (db) => ({
    categories: await db.categories.orderBy('sort').toArray(),
    products: await db.products.toArray(),
    sizes: await db.sizes.toArray(),
  }));
  const [showArchived, setShowArchived] = useState(false);
  if (!data) return <AdminLayout>{null}</AdminLayout>;
  const archived = data.products.filter((p) => p.archived_at).length;
  if (data.products.length === 0) {
    return (
      <AdminLayout>
        <PageTitle title={t('nav.products')} />
        <FirstRun />
      </AdminLayout>
    );
  }
  return (
    <AdminLayout>
      <PageTitle title={t('nav.products')} aside={<Link className="a-btn a-btn-primary" to="/admin/products/new">{t('admin.product.add')}</Link>} />
      {data.categories.map((c) => {
        const products = data.products
          .filter((p) => p.category_id === c.id && (showArchived || !p.archived_at))
          .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
        if (products.length === 0) return null;
        return (
          <section key={c.id} className="a-card a-plist" aria-labelledby={`cat-${c.id}`}>
            <h2 id={`cat-${c.id}`}>{categoryName(c, locale)}</h2>
            {products.map((p) => {
              const sizes = enabledSizes(data.sizes.filter((s) => s.product_id === p.id));
              const from = Math.min(...sizes.map((s) => s.price_kes));
              return (
                <Link key={p.id} to={`/admin/products/${p.id}`} className="a-prow">
                  <span className="a-prow-name">
                    <strong>{productName(p, locale)}</strong>
                    <span>
                      {sizes.length === 1
                        ? `${sizeLabel(sizes[0]!, locale)} · ${formatKES(sizes[0]!.price_kes)}`
                        : sizes.length > 1
                          ? t('sell.from', { price: formatKES(from) }) + ` · ${t('sell.sizes', { count: sizes.length })}`
                          : t('admin.product.noSizes')}
                    </span>
                  </span>
                  <span className={`a-prow-stock${negativePools(p, data.sizes.filter((s) => s.product_id === p.id)).length ? ' is-neg' : ''}`}>{productStockText(p, data.sizes, t, locale)}</span>
                  {p.archived_at ? (
                    <StatusChip status="voided" className="a-chip-sm">{t('admin.product.archived')}</StatusChip>
                  ) : p.manual_out_of_stock ? (
                    <StatusChip status="outOfStock" className="a-chip-sm" />
                  ) : isProductLow(p, data.sizes.filter((s) => s.product_id === p.id)) ? (
                    <StatusChip status="needsReview" className="a-chip-sm">{t('admin.product.low')}</StatusChip>
                  ) : null}
                </Link>
              );
            })}
          </section>
        );
      })}
      {archived > 0 && (
        <button type="button" className="a-text-btn" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? t('admin.product.hideArchived') : t('admin.product.showArchived', { count: archived })}
        </button>
      )}
    </AdminLayout>
  );
}

interface SizeDraft {
  id: string;
  label: string;
  label_sw: string;
  /** Deduction per mode, so switching mode and back keeps what was typed. */
  deduct: Record<StockMode, string>;
  price: string;
  enabled: boolean;
  sort: number;
  isNew: boolean;
  /** Taken off the product when saved (kept on record for the orders that used it). */
  removed: boolean;
  saved: ProductSize | null;
  /** Stock per size: '' = keeps its own stock, else the size it is poured from. */
  stock_from: string;
  /** Stock per size: warn at or below this many bottles (or pieces) of this size. */
  low: string;
}

interface PackDraft {
  id: string;
  label: string;
  count: string;
  size_id: string;
}

interface Draft {
  name: string;
  name_sw: string;
  category_id: string;
  stock_mode: StockMode;
  /** Per mode, like the deductions: bottles in count mode, ml in ml mode. */
  low_stock_at: Record<StockMode, string>;
  manual_out_of_stock: boolean;
  /** Each size keeps its own stock. */
  per_size: boolean;
  sizes: SizeDraft[];
  /** What it is delivered in, per mode (crates of bottles, or boxes of a bottle size). */
  packs: Record<StockMode, PackDraft[]>;
}

const toPackDrafts = (packs: Pack[]): PackDraft[] => packs.map((p) => ({ id: p.id, label: p.label, count: String(p.count), size_id: p.size_id ?? '' }));
const other = (m: StockMode): StockMode => (m === 'ml' ? 'count' : 'ml');

function toDraft(product: Product, sizes: ProductSize[], t: TFunction): Draft {
  const low = product.low_stock_at === null ? '' : String(product.low_stock_at);
  return {
    name: product.name,
    name_sw: product.name_sw ?? '',
    category_id: product.category_id,
    stock_mode: product.stock_mode,
    low_stock_at: { [product.stock_mode]: low, [other(product.stock_mode)]: '' } as Record<StockMode, string>,
    manual_out_of_stock: product.manual_out_of_stock,
    per_size: product.per_size === true,
    packs: {
      [product.stock_mode]: toPackDrafts(packsOf(product, t)),
      [other(product.stock_mode)]: toPackDrafts(defaultPacks({ ...product, stock_mode: other(product.stock_mode) }, t)),
    } as Record<StockMode, PackDraft[]>,
    sizes: [...sizes].filter((s) => !s.archived_at).sort((a, b) => a.sort - b.sort).map((s) => ({
      id: s.id,
      label: s.label_en,
      label_sw: s.label_sw,
      deduct: product.stock_mode === 'ml' ? { ml: String(s.deduct), count: '1' } : { count: String(s.deduct), ml: '' },
      price: formatAmount(s.price_kes),
      enabled: s.enabled,
      sort: s.sort,
      isNew: false,
      removed: false,
      saved: s,
      stock_from: s.stock_from ?? '',
      low: s.low_stock_at == null ? '' : String(product.stock_mode === 'ml' ? Math.round(s.low_stock_at / s.deduct) : s.low_stock_at),
    })),
  };
}

type DraftError = 'name' | 'sizes' | 'size' | 'pack' | 'pour';

/** The records a draft would save, or what is wrong with it. `at` stamps sizes that were removed. */
export function fromDraft(draft: Draft, base: Product, at: string, t: TFunction): { product: Product; sizes: ProductSize[] } | { error: DraftError } {
  const name = draft.name.trim();
  if (!name) return { error: 'name' };
  const sizes: ProductSize[] = [];
  for (const [i, s] of draft.sizes.entries()) {
    if (s.removed) {
      // Off the counter for good; the row stays for the orders that sold it.
      if (s.saved) sizes.push({ ...s.saved, enabled: false, archived_at: s.saved.archived_at ?? at });
      continue;
    }
    const deduct = Number(s.deduct[draft.stock_mode]);
    const price = parseKes(s.price);
    if (!s.label.trim() || !Number.isSafeInteger(deduct) || deduct <= 0 || price === null) return { error: 'size' };
    const low = draft.per_size && !s.stock_from && s.low.trim() !== '' ? Number(s.low) * (draft.stock_mode === 'ml' ? deduct : 1) : null;
    sizes.push({
      ...(s.saved ?? {}),
      stock_from: draft.per_size ? s.stock_from || null : null,
      low_stock_at: low,
      id: s.id,
      product_id: base.id,
      label_en: s.label.trim(),
      // The Kiswahili label follows the English one unless it was set apart.
      label_sw: s.label_sw.trim() && !s.isNew ? s.label_sw.trim() : s.label.trim(),
      deduct,
      price_kes: price,
      enabled: s.enabled,
      sort: i,
    });
  }
  if (!sizes.some((s) => s.enabled && !s.archived_at)) return { error: 'sizes' };
  if (draft.per_size) {
    // Poured from a size that keeps stock of its own, and at least one does.
    const own = new Set(sizes.filter((s) => !s.archived_at && !s.stock_from).map((s) => s.id));
    if (own.size === 0 || sizes.some((s) => !s.archived_at && s.stock_from && !own.has(s.stock_from))) return { error: 'pour' };
  }
  const lowText = draft.low_stock_at[draft.stock_mode].trim();
  const low = lowText === '' ? null : Number(lowText.replace(/[^0-9]/g, ''));
  const packs: Pack[] = [];
  for (const p of draft.packs[draft.stock_mode]) {
    const count = Number(p.count);
    const bottle = sizes.find((s) => s.id === p.size_id && !s.archived_at && s.deduct >= 250);
    if (!p.label.trim() || !Number.isSafeInteger(count) || count < 1) return { error: 'pack' };
    if (draft.stock_mode === 'ml' && !bottle) return { error: 'pack' };
    // Counted things with stock per size: a pack is of one size (none chosen = the largest).
    const ofSize = draft.per_size && draft.stock_mode === 'count' && sizes.some((s) => s.id === p.size_id && !s.archived_at) ? p.size_id : null;
    packs.push({ id: p.id, label: p.label.trim(), count, size_id: draft.stock_mode === 'ml' ? p.size_id : ofSize });
  }
  // Left as the usual crates until the owner changes them (so they follow the language).
  const usual = JSON.stringify(packs) === JSON.stringify(defaultPacks({ ...base, stock_mode: draft.stock_mode, category_id: draft.category_id }, t).map((p) => ({ ...p, size_id: null })));
  const keepUsual = (base.packs === undefined || base.packs === null) && usual;
  return {
    product: {
      ...base,
      name,
      name_sw: draft.name_sw.trim() || null,
      category_id: draft.category_id,
      stock_mode: draft.stock_mode,
      low_stock_at: low,
      manual_out_of_stock: draft.manual_out_of_stock,
      packs: keepUsual ? base.packs ?? null : packs,
      per_size: draft.per_size,
    },
    sizes,
  };
}

function Switch({ on, onChange, label, children, tone = 'paid' }: { on: boolean; onChange: (on: boolean) => void; label: string; children?: React.ReactNode; tone?: 'paid' | 'error' }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`a-switch is-${tone}`} onClick={() => onChange(!on)}>
      <span className="a-switch-track"><span /></span>
      {children}
    </button>
  );
}

/**
 * "Warn when the shelf count is at or below … bottles" (count mode: the
 * counter's "3 left") or "… ml" (ml mode), following the mode chosen above
 * even before it is saved.
 */
function AlertField({ d, unit, onChange }: { d: Draft; unit: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const count = d.stock_mode === 'count';
  const id = useId();
  return (
    <div className="a-field a-field-sm">
      <label htmlFor={id}>{count ? t('admin.product.alertCount') : t('admin.product.alertMl')}</label>
      <span className="a-input-unit">
        <input id={id} type="text" inputMode="numeric" aria-describedby={`${id}-hint`} value={d.low_stock_at[d.stock_mode]} placeholder={t('admin.product.noAlert')} onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))} />
        <span>{unit}</span>
      </span>
      <span id={`${id}-hint`} className="a-field-hint">{count ? t('admin.product.alertCountHint') : t('admin.product.alertMlHint')}</span>
    </div>
  );
}

/** "In stock now: [ 24 ] bottles", in the unit of the counting method chosen above. */
function StockField({ label, unit, value, onChange, hint }: { label: string; unit: string; value: string; onChange: (v: string) => void; hint: string }) {
  const id = useId();
  return (
    <div className="a-field a-field-sm">
      <label htmlFor={id}>{label}</label>
      <span className="a-input-unit">
        <input id={id} type="text" inputMode="numeric" aria-describedby={hint ? `${id}-hint` : undefined} value={value} onFocus={(e) => e.target.select()} onChange={(e) => onChange(e.target.value)} />
        <span>{unit}</span>
      </span>
      {hint && <span id={`${id}-hint`} className="a-field-hint">{hint}</span>}
    </div>
  );
}

/**
 * Save and Add stock together at the foot of the stock card, so an owner who
 * changed the product further up saves it here, without scrolling back up,
 * before adding stock. "Save stock" when only stock figures changed.
 */
function StockActions({ product, dirty, stockOnly, error, onSave }: { product: Product; dirty: boolean; stockOnly: boolean; error: string | null; onSave: () => void }) {
  const { t } = useI18n();
  return (
    <>
      {dirty && error && <p className="a-error">{error}</p>}
      <div className="a-actions">
        {dirty && <button type="button" className="a-btn a-btn-primary a-btn-sm" onClick={onSave}>{t(stockOnly ? 'admin.product.saveStock' : 'admin.product.saveProduct')}</button>}
        <Link className={`a-btn a-btn-sm${dirty ? '' : ' a-btn-primary'}`} to={`/admin/stock/new?product=${product.id}`}>{t('action.addStock')}</Link>
      </div>
    </>
  );
}

/** Stock per size: "Warn when 750ml is at or below … bottles" (stored as ml for spirits). */
function SizeAlert({ size, onChange }: { size: SizeDraft; onChange: (low: string) => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="a-field a-field-sm">
      <label htmlFor={id}>{t('admin.size.alert', { size: size.label || t('admin.product.newSize') })}</label>
      <span className="a-input-unit">
        <input id={id} type="text" inputMode="numeric" value={size.low} placeholder={t('admin.product.noAlert')} onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))} />
        <span>{t('admin.unit.bottles')}</span>
      </span>
    </div>
  );
}

function SizeAlerts({ d, onChange }: { d: Draft; onChange: (id: string, low: string) => void }) {
  const { t } = useI18n();
  return (
    <>
      {d.sizes.filter((s) => !s.removed && !s.stock_from).map((s) => <SizeAlert key={s.id} size={s} onChange={(low) => onChange(s.id, low)} />)}
      <p className="a-field-hint">{t('admin.size.alertHint')}</p>
    </>
  );
}

/** Product editor (Product.dc.html). R-STOCK-1, R-SELL-2, R-SELL-5. */
export function ProductEditorScreen() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const db = useDb();
  const { t, locale } = useI18n();
  const { ctx, kaunta } = useAdmin();
  const navigate = useNavigate();
  const loaded = useQuery(async (d) => {
    const categories = await d.categories.orderBy('sort').toArray();
    const product = isNew ? undefined : await d.products.get(id);
    const sizes = product ? await d.sizes.where('product_id').equals(product.id).toArray() : [];
    const history = product ? visibleTo(await d.auditEvents.where('ref_id').equals(product.id).toArray(), kaunta).sort((a, b) => b.at.localeCompare(a.at)) : [];
    const people = await d.people.toArray();
    return { categories, product, sizes, history, people };
  }, [id, kaunta]);

  const base = useMemo<Product | null>(() => {
    if (!loaded) return null;
    if (loaded.product) return loaded.product;
    if (!isNew) return null;
    return { id: uuidv7(), category_id: loaded.categories[0]?.id ?? '', name: '', name_sw: null, stock_mode: 'count', stock_qty: 0, low_stock_at: null, manual_out_of_stock: false, archived_at: null, sort: 999 };
  }, [loaded, isNew]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /**
   * The stock figures as typed, by "<mode>:all" (one pool) or "<mode>:<size id>"
   * (per size), in the unit of that counting method. Not typed = the saved
   * figure, converted when the counting method was changed above.
   */
  const [typed, setTyped] = useState<Record<string, string>>({});

  if (!loaded) return <AdminLayout>{null}</AdminLayout>;
  if (!base) {
    return (
      <AdminLayout>
        <PageTitle title={t('admin.product.notFound')} />
        <Link className="a-link" to="/admin/products">← {t('nav.products')}</Link>
      </AdminLayout>
    );
  }
  const original = loaded.product ? toDraft(loaded.product, loaded.sizes, t) : { ...toDraft(base, [], t), sizes: [] };
  const d = draft ?? original;
  const edit = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...d, ...patch });
  };
  const editSize = (i: number, patch: Partial<SizeDraft>) => edit({ sizes: d.sizes.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const removeSize = (i: number) => {
    const s = d.sizes[i]!;
    const sizes = s.isNew ? d.sizes.filter((_, j) => j !== i) : d.sizes.map((x, j) => (j === i ? { ...x, removed: true } : x));
    // A box of a bottle size that is gone goes with it.
    edit({ sizes, packs: { ...d.packs, ml: d.packs.ml.filter((p) => p.size_id !== s.id) } });
  };
  /** On: each size keeps its own stock; a tot is poured from the largest bottle to start with. */
  const setPerSize = (on: boolean) => {
    if (!on) return edit({ per_size: false });
    const live = d.sizes.filter((s) => !s.removed);
    const largest = [...live].filter((s) => d.stock_mode !== 'ml' || Number(s.deduct.ml) >= 250).sort((a, b) => Number(b.deduct[d.stock_mode]) - Number(a.deduct[d.stock_mode]))[0];
    edit({
      per_size: true,
      sizes: d.sizes.map((s) => ({
        ...s,
        stock_from: s.stock_from || (d.stock_mode === 'ml' && largest && s.id !== largest.id && Number(s.deduct.ml) < 250 ? largest.id : ''),
      })),
    });
  };
  const ownDrafts = d.sizes.filter((s) => !s.removed && !s.stock_from);
  const packs = d.packs[d.stock_mode];
  const setPacks = (next: PackDraft[]) => edit({ packs: { ...d.packs, [d.stock_mode]: next } });
  const editPack = (i: number, patch: Partial<PackDraft>) => setPacks(packs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const ml = d.stock_mode === 'ml';
  const liveSizes = d.sizes.filter((s) => !s.removed);
  const removedSizes = d.sizes.filter((s) => s.removed);
  const bottleDrafts = liveSizes.filter((s) => Number(s.deduct.ml) >= 250);
  const shelfTracked = !['food', 'keg'].includes(d.category_id) && !isKegProduct({ category_id: d.category_id });
  const unit = ml ? 'ml' : t('admin.unit.bottles');
  const draftDirty = JSON.stringify(d) !== JSON.stringify(original);
  const product = loaded.product;
  const enabled = liveSizes.filter((s) => s.enabled);
  const from = enabled.length ? Math.min(...enabled.map((s) => parseKes(s.price) ?? 0)) : null;
  const tracked = (product?.stock_qty ?? base.stock_qty) !== null;
  const lastChange = loaded.history.find((h) => h.kind === 'product_saved');

  const save = async () => {
    const result = fromDraft(d, base, new Date(ctx.now!().getTime()).toISOString(), t);
    if ('error' in result) {
      setError(t(`admin.product.error.${result.error}`));
      return;
    }
    if (changes.some((c) => c.qty === null)) {
      setError(t('admin.product.error.stock'));
      return;
    }
    setError(null);
    const before = loaded.product ? { product: loaded.product, sizes: loaded.sizes } : null;
    if (isNew && ['food', 'keg'].includes(result.product.category_id)) result.product.stock_qty = null;
    if (draftDirty) await recordAdminEvent(db, ctx, { type: 'product_saved', payload: { ...result, before } });
    // The stock as typed, in the unit just saved: a count, so the audit log shows before → after.
    for (const c of changes) {
      await recordAdminEvent(db, ctx, { type: 'shelf_counted', payload: { product_id: result.product.id, counted_qty: c.qty!, before_qty: c.before, ...(c.size_id ? { size_id: c.size_id } : {}) } });
    }
    setTyped({});
    setDraft(null);
    setSaved(true);
    if (isNew) navigate(`/admin/products/${result.product.id}`, { replace: true });
  };

  const setArchived = async (archived: boolean) => {
    if (!loaded.product) return;
    await recordAdminEvent(db, ctx, {
      type: 'product_saved',
      payload: { product: { ...loaded.product, archived_at: archived ? new Date(ctx.now!().getTime()).toISOString() : null }, sizes: loaded.sizes, before: { product: loaded.product, sizes: loaded.sizes } },
    });
  };

  const perSizeSaved = product ? isPerSize(product) : false;
  const pools = product && perSizeSaved ? stockedSizes(product, loaded.sizes) : [];
  const usePools = perSizeSaved && d.per_size;
  const modeChanged = !!product && d.stock_mode !== product.stock_mode;
  // A bottle, for turning ml into bottles and back: the largest bottle size, else 750 ml.
  const bottleMl = Math.max(0, ...liveSizes.map((s) => Number(s.deduct.ml) || 0).filter((n) => n >= 250)) || 750;
  const convert = (q: number, perMl: number) => (!modeChanged ? q : d.stock_mode === 'count' ? Math.round(q / perMl) : q * perMl);
  const poolMl = (pool: ProductSize) => (product?.stock_mode === 'ml' ? pool.deduct : Number(d.sizes.find((s) => s.id === pool.id)?.deduct.ml) || bottleMl);
  const stockKey = (sizeId: string | null) => `${d.stock_mode}:${sizeId ?? 'all'}`;
  const shownStock = (pool: ProductSize | null): string =>
    typed[stockKey(pool?.id ?? null)] ?? String(pool ? convert(pool.stock_qty ?? 0, poolMl(pool)) : convert(product?.stock_qty ?? 0, bottleMl));
  const setStock = (sizeId: string | null, v: string) => {
    setSaved(false);
    setTyped({ ...typed, [stockKey(sizeId)]: v.replace(/[^0-9]/g, '').slice(0, 7) });
  };
  /** Stock figures to save as counts: what was typed, or every figure when the counting method changed. */
  const stockChanges = (): { size_id: string | null; qty: number | null; before: number }[] => {
    if (!product || !tracked || isNew) return [];
    const targets = usePools ? pools.map((pool) => ({ size_id: pool.id, text: shownStock(pool), before: pool.stock_qty ?? 0 })) : [{ size_id: null, text: shownStock(null), before: product.stock_qty ?? 0 }];
    return targets
      .map((x) => ({ size_id: x.size_id, qty: x.text.trim() === '' ? null : Number(x.text), before: x.before }))
      .filter((x) => modeChanged || x.qty !== x.before);
  };
  const changes = stockChanges();
  const dirty = draftDirty || changes.length > 0;

    const bottles750 = product && ml && product.stock_qty !== null && product.stock_qty > 0 ? Math.round((product.stock_qty / 750) * 2) / 2 : null;

  return (
    <AdminLayout>
      <div className="a-title-row is-center">
        <div className="a-title-stack">
          <Link className="a-link a-link-sm" to="/admin/products">← {t('nav.products')}</Link>
          <h1>{isNew ? t('admin.product.new') : product?.name}</h1>
        </div>
        <div className="a-actions">
          <button type="button" className="a-btn" disabled={!dirty} onClick={() => { setDraft(null); setTyped({}); setError(null); }}>{t('common.cancel')}</button>
          <button type="button" className="a-btn a-btn-primary" disabled={!dirty} onClick={save}>{t('common.save')}</button>
        </div>
      </div>
      {error && <p className="a-error" role="alert">{error}</p>}
      {saved && !dirty && <p className="a-ok" role="status"><Icon name="check" size={18} /> {t('admin.product.saved')}</p>}
      {product?.archived_at && <p className="a-error">{t('admin.product.isArchived')}</p>}

      <div className="a-row is-top">
        <div className="a-col a-grow-main">
          <section className="a-card">
            <h2>{t('product.basics')}</h2>
            <div className="a-fields">
              <label className="a-field">
                {t('product.name')}
                <input type="text" value={d.name} onChange={(e) => edit({ name: e.target.value })} />
              </label>
              <label className="a-field">
                <span>{t('product.nameSw')} <span className="a-field-hint">{t('admin.product.nameSwHint')}</span></span>
                <input type="text" value={d.name_sw} placeholder={t('admin.product.sameAsName')} onChange={(e) => edit({ name_sw: e.target.value })} />
              </label>
              <label className="a-field">
                {t('product.category')}
                <select value={d.category_id} onChange={(e) => edit({ category_id: e.target.value })}>
                  {loaded.categories.map((c) => <option key={c.id} value={c.id}>{categoryName(c, locale)}</option>)}
                </select>
              </label>
            </div>
          </section>

          <section className="a-card">
            <h2 id="mode-h">{t('product.stockMode')}</h2>
            <div role="radiogroup" aria-labelledby="mode-h" className="a-radios">
              {(['count', 'ml'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={d.stock_mode === m} className="a-radio-card" onClick={() => edit({ stock_mode: m })}>
                  <span className="a-radio-dot" />
                  <span>
                    <strong>{t(m === 'ml' ? 'product.modeMl' : 'product.modeCount')}</strong>
                    <span>{t(m === 'ml' ? 'product.modeMlHint' : 'product.modeCountHint')}</span>
                  </span>
                </button>
              ))}
            </div>
            {product && modeChanged && product.stock_qty !== null && <p className="a-note is-strong">{t('admin.product.modeChanged', { unit })}</p>}
            {shelfTracked && tracked && (
              <div className="a-persize">
                <Switch on={d.per_size} label={t('admin.size.perSize')} onChange={setPerSize}>
                  <span className="a-switch-label">{t('admin.size.perSize')}</span>
                </Switch>
                <p className="a-note">{t(d.stock_mode === 'ml' ? 'admin.size.perSizeHintMl' : 'admin.size.perSizeHintCount')}</p>
                {product && product.stock_qty !== null && d.per_size && !perSizeSaved && (
                  <p className="a-note is-strong">{t('admin.size.switchOn', { total: stockText(product, t) })}</p>
                )}
                {product && !d.per_size && perSizeSaved && <p className="a-note is-strong">{t('admin.size.switchOff')}</p>}
              </div>
            )}
          </section>

          <section className="a-card">
            <div className="a-card-head">
              <h2>{t('product.sizes')}</h2>
              <span className="a-muted">{ml ? t('admin.product.deductHintMl') : t('admin.product.deductHintCount')}</span>
            </div>
            <div className="a-table-wrap">
              <table className="a-table a-sizes">
                <thead>
                  <tr>
                    <th scope="col">{t('product.label')}</th>
                    <th scope="col">{t(ml ? 'product.deductMl' : 'product.deductCount')}</th>
                    <th scope="col">{t('product.price')}</th>
                    <th scope="col">{t('product.sold')}</th>
                    {d.per_size && <th scope="col">{t('admin.size.stockCol')}</th>}
                    <th scope="col"><span className="a-sr">{t('admin.product.removeCol')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {d.sizes.map((s, i) => s.removed ? null : (
                    <tr key={s.id}>
                      <td className="a-c-label" data-label={t('product.label')}><input className="a-input" type="text" value={s.label} aria-label={t('admin.product.sizeLabelAria', { n: i + 1 })} onChange={(e) => editSize(i, { label: e.target.value })} /></td>
                      <td className="a-c-deduct" data-label={t(ml ? 'product.deductMl' : 'product.deductCount')}><input className="a-input is-num" type="text" inputMode="numeric" value={s.deduct[d.stock_mode]} aria-label={t('admin.product.deductAria', { size: s.label })} onChange={(e) => editSize(i, { deduct: { ...s.deduct, [d.stock_mode]: e.target.value.replace(/[^0-9]/g, '') } })} /></td>
                      <td className="a-c-price" data-label={t('product.price')}><input className="a-input is-num is-strong" type="text" inputMode="numeric" value={s.price} aria-label={t('admin.product.priceAria', { size: s.label })} onChange={(e) => { const n = parseKes(e.target.value); editSize(i, { price: n === null ? '' : formatAmount(n) }); }} /></td>
                      <td className="a-c-sold" data-label={t('product.sold')}>
                        <Switch on={s.enabled} label={t('admin.product.sellAria', { size: s.label })} onChange={(on) => editSize(i, { enabled: on })}>
                          <span className="a-switch-state">{s.enabled ? t('admin.on') : t('admin.off')}</span>
                        </Switch>
                      </td>
                      {d.per_size && (
                        <td className="a-c-stock" data-label={t('admin.size.stockCol')}>
                          <select
                            className="a-select-sm"
                            value={s.stock_from}
                            aria-label={t('admin.size.stockFromAria', { size: s.label || t('admin.product.newSize') })}
                            onChange={(e) => edit({ sizes: d.sizes.map((x, j) => (j === i ? { ...x, stock_from: e.target.value } : x.stock_from === s.id ? { ...x, stock_from: '' } : x)) })}
                          >
                            <option value="">{t('admin.size.own')}</option>
                            {d.sizes.filter((o) => o.id !== s.id && !o.removed && !o.stock_from).map((o) => (
                              <option key={o.id} value={o.id}>{t('admin.size.from', { size: o.label || t('admin.product.newSize') })}</option>
                            ))}
                          </select>
                        </td>
                      )}
                      <td className="a-c-remove">
                        <button type="button" className="a-icon-btn" aria-label={t('admin.product.removeSize', { size: s.label || t('admin.product.newSize') })} onClick={() => removeSize(i)}>
                          <Icon name="close" size={18} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {removedSizes.length > 0 && (
              <p className="a-note a-removed">
                {t('admin.product.sizesRemoved', { sizes: removedSizes.map((s) => s.label).join(', ') })}{' '}
                <button type="button" className="a-text-btn" onClick={() => edit({ sizes: d.sizes.map((s) => ({ ...s, removed: false })) })}>{t('admin.product.undoRemove')}</button>
              </p>
            )}
            <button
              type="button"
              className="a-btn a-btn-dashed"
              onClick={() => edit({ sizes: [...d.sizes, { id: uuidv7(), label: '', label_sw: '', deduct: { count: '1', ml: '' }, price: '', enabled: true, sort: d.sizes.length, isNew: true, removed: false, saved: null, stock_from: '', low: '' }] })}
            >
              {t('product.addSize')}
            </button>
            <p className="a-info">{t('product.priceNote')}</p>
          </section>

          {shelfTracked && (
            <section className="a-card">
              <div className="a-card-head">
                <h2>{t('admin.pack.title')}</h2>
                <span className="a-muted">{ml ? t('admin.pack.hintMl') : t('admin.pack.hintCount')}</span>
              </div>
              {packs.length > 0 && (
                <div className="a-table-wrap">
                  <table className="a-table a-sizes a-packs">
                    <thead>
                      <tr>
                        <th scope="col">{t('admin.pack.label')}</th>
                        <th scope="col">{t('admin.pack.countShort')}</th>
                        {(ml || d.per_size) && <th scope="col">{t('admin.pack.bottle')}</th>}
                        <th scope="col"><span className="a-sr">{t('admin.product.removeCol')}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {packs.map((p, i) => (
                        <tr key={p.id}>
                          <td className="a-c-label" data-label={t('admin.pack.label')}><input className="a-input" type="text" value={p.label} placeholder={t('admin.pack.labelHint')} aria-label={t('admin.pack.labelAria', { n: i + 1 })} onChange={(e) => editPack(i, { label: e.target.value })} /></td>
                          <td className="a-c-deduct" data-label={t('admin.pack.countShort')}><input className="a-input is-num" type="text" inputMode="numeric" value={p.count} aria-label={t('admin.pack.countAria', { pack: p.label || String(i + 1) })} onChange={(e) => editPack(i, { count: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) })} /></td>
                          {(ml || d.per_size) && (
                            <td className="a-c-price" data-label={t('admin.pack.bottle')}>
                              <select className="a-select-sm" value={p.size_id} aria-label={t('admin.pack.bottleAria', { pack: p.label || String(i + 1) })} onChange={(e) => editPack(i, { size_id: e.target.value })}>
                                <option value="" disabled={ml}>{ml ? t('admin.pack.chooseBottle') : t('admin.size.largest')}</option>
                                {(ml ? bottleDrafts.filter((s) => !d.per_size || !s.stock_from) : ownDrafts).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                              </select>
                            </td>
                          )}
                          <td className="a-c-remove">
                            <button type="button" className="a-icon-btn" aria-label={t('admin.pack.remove', { pack: p.label || String(i + 1) })} onClick={() => setPacks(packs.filter((_, j) => j !== i))}>
                              <Icon name="close" size={18} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button
                type="button"
                className="a-btn a-btn-dashed"
                disabled={ml && bottleDrafts.length === 0}
                onClick={() => setPacks([...packs, { id: uuidv7(), label: '', count: '', size_id: ml ? (bottleDrafts.find((s) => s.deduct.ml === '750')?.id ?? bottleDrafts[0]?.id ?? '') : '' }])}
              >
                {t('admin.pack.add')}
              </button>
              <p className="a-note">{ml ? t('admin.pack.alwaysMl') : t('admin.pack.alwaysCount')}</p>
            </section>
          )}

          {product && (
            <section className="a-card a-archive">
              <div>
                <h2>{product.archived_at ? t('admin.product.restoreTitle') : t('product.archive')}</h2>
                <p className="a-note">{t('product.archiveBody')}</p>
              </div>
              {product.archived_at ? (
                <button type="button" className="a-btn" onClick={() => setArchived(false)}>{t('admin.product.restore', { name: product.name })}</button>
              ) : (
                <button type="button" className="a-btn a-btn-danger" onClick={() => setArchived(true)}>{t('admin.product.archiveName', { name: product.name })}</button>
              )}
            </section>
          )}
        </div>

        <aside className="a-col a-grow-side">
          {isNew && shelfTracked && (
            <section className="a-card">
              <h2>{t('product.inStock')}</h2>
              {d.per_size ? <SizeAlerts d={d} onChange={(id, low) => edit({ sizes: d.sizes.map((s) => (s.id === id ? { ...s, low } : s)) })} /> : (
                <AlertField d={d} unit={unit} onChange={(v) => edit({ low_stock_at: { ...d.low_stock_at, [d.stock_mode]: v } })} />
              )}
            </section>
          )}
          {product && tracked && usePools && (
            <section className="a-card" aria-labelledby="sizestock-h">
              <h2 id="sizestock-h">{t('admin.size.title')}</h2>
              <ul className="a-sizestock">
                {pools.map((pool) => {
                  const qty = pool.stock_qty ?? 0;
                  const poured = loaded.sizes.filter((s) => s.stock_from === pool.id && !s.archived_at);
                  const draftSize = d.sizes.find((s) => s.id === pool.id);
                  const shown = shownStock(pool);
                  return (
                    <li key={pool.id} className={qty < 0 ? 'is-neg' : ''}>
                      <div className="a-sizestock-head">
                        <strong>{sizeLabel(pool, locale)}</strong>
                        {!modeChanged && <span className="a-sizestock-qty">{sizeStockText(product.stock_mode, qty, pool.deduct, t)}</span>}
                        {isSizeLow(pool) && <StatusChip status="needsReview" className="a-chip-sm">{t('admin.product.low')}</StatusChip>}
                      </div>
                      {poured.length > 0 && <span className="a-note">{t('admin.size.poured', { sizes: poured.map((s) => sizeLabel(s, locale)).join(', ') })}</span>}
                      <StockField
                        label={t('admin.size.stockNow', { size: sizeLabel(pool, locale) })}
                        unit={unit}
                        value={shown}
                        onChange={(v) => setStock(pool.id, v)}
                        hint={[
                          ml && shown !== '' ? sizeStockText('ml', Number(shown), poolMl(pool), t) : null,
                          modeChanged && typed[stockKey(pool.id)] === undefined ? t('admin.product.converted', { was: stockText({ ...product, stock_qty: qty }, t), ml: formatAmount(poolMl(pool)) }) : null,
                        ].filter(Boolean).join(' · ')}
                      />
                      {draftSize && !draftSize.stock_from && (
                        <SizeAlert size={draftSize} onChange={(low) => edit({ sizes: d.sizes.map((s) => (s.id === pool.id ? { ...s, low } : s)) })} />
                      )}
                    </li>
                  );
                })}
              </ul>
              {!modeChanged && (
                <div className="a-legend is-sm">
                  <span>{t('admin.size.total')}</span>
                  <strong>{stockText(product, t)}</strong>
                </div>
              )}
              <StockActions product={product} dirty={dirty} stockOnly={!draftDirty} error={error} onSave={save} />
            </section>
          )}
          {product && tracked && !usePools && (
            <section className="a-card">
              <h2>{t('product.inStock')}</h2>
              {!modeChanged && (
                <>
                  <div className={`a-stock-big${isNegativeStock(product) ? ' is-neg' : ''}`}>{stockText(product, t)}</div>
                  <div className="a-note">
                    {[bottles750 !== null ? t('admin.product.about750', { n: bottles750 }) : null,
                      product.low_stock_at !== null ? t('admin.product.alertBelow', { qty: stockText({ ...product, stock_qty: product.low_stock_at }, t) }) : null]
                      .filter(Boolean).join(' · ')}
                  </div>
                </>
              )}
              <StockField
                label={t('admin.product.stockNow')}
                unit={unit}
                value={shownStock(null)}
                onChange={(v) => setStock(null, v)}
                hint={modeChanged && typed[stockKey(null)] === undefined
                  ? t('admin.product.converted', { was: stockText(product, t), ml: formatAmount(bottleMl) })
                  : t('admin.product.stockNowHint')}
              />
              <AlertField d={d} unit={unit} onChange={(v) => edit({ low_stock_at: { ...d.low_stock_at, [d.stock_mode]: v } })} />
              <StockActions product={product} dirty={dirty} stockOnly={!draftDirty} error={error} onSave={save} />
            </section>
          )}
          <section className="a-card">
            <h2>{t('product.oos')}</h2>
            <Switch tone="error" on={d.manual_out_of_stock} label={t('product.oos')} onChange={(on) => edit({ manual_out_of_stock: on })}>
              <span className="a-switch-label">{d.manual_out_of_stock ? t('product.oosOn') : t('product.oosOff')}</span>
            </Switch>
            <p className="a-note">{t('product.oosHint')}</p>
            <div className="a-note is-strong">{t('admin.product.onCounter')}</div>
            {/* The counter tile, as Counter Night draws it. */}
            <div className={`a-tile-preview${d.manual_out_of_stock ? ' is-oos' : ''}`} aria-hidden="true">
              <span>{d.name || '…'}</span>
              <strong>{d.manual_out_of_stock ? t('status.outOfStock') : from !== null ? (enabled.length > 1 ? t('sell.from', { price: formatKES(from) }) : formatKES(from)) : ''}</strong>
            </div>
          </section>
          {lastChange && (
            <section className="a-history">
              {t('admin.product.lastChanged', { time: hhmm(lastChange.at), name: personName(loaded.people, lastChange.actor_id) })}{' '}
              <Link to={`/admin/audit?q=${encodeURIComponent(product?.name ?? '')}`}>{t('admin.product.history')}</Link>
            </section>
          )}
        </aside>
      </div>
    </AdminLayout>
  );
}
