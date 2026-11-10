import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { StatusChip } from '../components/StatusChip';
import { productName, sizeLabel } from '../counter/labels';
import { recordAdminEvent } from '../data/adminEvents';
import { useDb, useQuery } from '../data/react';
import { uuidv7 } from '../domain/ids';
import { enabledSizes, isLowStock, isNegativeStock } from '../domain/stock';
import type { Category, Product, ProductSize, StockMode } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import type { TFunction } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import { AdminLayout, PageTitle } from './AdminLayout';
import { useAdmin } from './AdminSession';
import { hhmm, personName } from './data';
import { parseKes } from './ReconcileScreen';

/** "4,850 ml", "24 bottles", "−4 bottles" (a count, so it may be negative). */
export function stockText(product: Pick<Product, 'stock_mode' | 'stock_qty'>, t: TFunction): string {
  if (product.stock_qty === null) return t('admin.product.notTracked');
  const n = product.stock_qty;
  const abs = formatAmount(Math.abs(n));
  return `${n < 0 ? '−' : ''}${abs} ${product.stock_mode === 'ml' ? 'ml' : t('admin.unit.bottles')}`;
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
                  <span className={`a-prow-stock${isNegativeStock(p) ? ' is-neg' : ''}`}>{stockText(p, t)}</span>
                  {p.archived_at ? (
                    <StatusChip status="voided" className="a-chip-sm">{t('admin.product.archived')}</StatusChip>
                  ) : p.manual_out_of_stock ? (
                    <StatusChip status="outOfStock" className="a-chip-sm" />
                  ) : isLowStock(p) ? (
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
}

interface Draft {
  name: string;
  name_sw: string;
  category_id: string;
  stock_mode: StockMode;
  low_stock_at: string;
  manual_out_of_stock: boolean;
  sizes: SizeDraft[];
}

function toDraft(product: Product, sizes: ProductSize[]): Draft {
  return {
    name: product.name,
    name_sw: product.name_sw ?? '',
    category_id: product.category_id,
    stock_mode: product.stock_mode,
    low_stock_at: product.low_stock_at === null ? '' : String(product.low_stock_at),
    manual_out_of_stock: product.manual_out_of_stock,
    sizes: [...sizes].sort((a, b) => a.sort - b.sort).map((s) => ({
      id: s.id,
      label: s.label_en,
      label_sw: s.label_sw,
      deduct: product.stock_mode === 'ml' ? { ml: String(s.deduct), count: '1' } : { count: String(s.deduct), ml: '' },
      price: formatAmount(s.price_kes),
      enabled: s.enabled,
      sort: s.sort,
      isNew: false,
    })),
  };
}

type DraftError = 'name' | 'sizes' | 'size';

/** The records a draft would save, or what is wrong with it. */
export function fromDraft(draft: Draft, base: Product): { product: Product; sizes: ProductSize[] } | { error: DraftError } {
  const name = draft.name.trim();
  if (!name) return { error: 'name' };
  const sizes: ProductSize[] = [];
  for (const [i, s] of draft.sizes.entries()) {
    const deduct = Number(s.deduct[draft.stock_mode]);
    const price = parseKes(s.price);
    if (!s.label.trim() || !Number.isSafeInteger(deduct) || deduct <= 0 || price === null) return { error: 'size' };
    sizes.push({
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
  if (!sizes.some((s) => s.enabled)) return { error: 'sizes' };
  const low = draft.low_stock_at.trim() === '' ? null : Number(draft.low_stock_at.replace(/[^0-9]/g, ''));
  return {
    product: {
      ...base,
      name,
      name_sw: draft.name_sw.trim() || null,
      category_id: draft.category_id,
      stock_mode: draft.stock_mode,
      low_stock_at: low,
      manual_out_of_stock: draft.manual_out_of_stock,
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

/** Product editor (Product.dc.html). R-STOCK-1, R-SELL-2, R-SELL-5. */
export function ProductEditorScreen() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const db = useDb();
  const { t, locale } = useI18n();
  const { ctx } = useAdmin();
  const navigate = useNavigate();
  const loaded = useQuery(async (d) => {
    const categories = await d.categories.orderBy('sort').toArray();
    const product = isNew ? undefined : await d.products.get(id);
    const sizes = product ? await d.sizes.where('product_id').equals(product.id).toArray() : [];
    const history = product ? (await d.auditEvents.where('ref_id').equals(product.id).toArray()).sort((a, b) => b.at.localeCompare(a.at)) : [];
    const people = await d.people.toArray();
    return { categories, product, sizes, history, people };
  }, [id]);

  const base = useMemo<Product | null>(() => {
    if (!loaded) return null;
    if (loaded.product) return loaded.product;
    if (!isNew) return null;
    return { id: uuidv7(), category_id: loaded.categories[0]?.id ?? '', name: '', name_sw: null, stock_mode: 'count', stock_qty: 0, low_stock_at: null, manual_out_of_stock: false, archived_at: null, sort: 999 };
  }, [loaded, isNew]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [counting, setCounting] = useState<string | null>(null);

  if (!loaded) return <AdminLayout>{null}</AdminLayout>;
  if (!base) {
    return (
      <AdminLayout>
        <PageTitle title={t('admin.product.notFound')} />
        <Link className="a-link" to="/admin/products">← {t('nav.products')}</Link>
      </AdminLayout>
    );
  }
  const original = loaded.product ? toDraft(loaded.product, loaded.sizes) : { ...toDraft(base, []), sizes: [] };
  const d = draft ?? original;
  const edit = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...d, ...patch });
  };
  const editSize = (i: number, patch: Partial<SizeDraft>) => edit({ sizes: d.sizes.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const ml = d.stock_mode === 'ml';
  const dirty = JSON.stringify(d) !== JSON.stringify(original);
  const product = loaded.product;
  const enabled = d.sizes.filter((s) => s.enabled);
  const from = enabled.length ? Math.min(...enabled.map((s) => parseKes(s.price) ?? 0)) : null;
  const tracked = (product?.stock_qty ?? base.stock_qty) !== null;
  const lastChange = loaded.history.find((h) => h.kind === 'product_saved');

  const save = async () => {
    const result = fromDraft(d, base);
    if ('error' in result) {
      setError(t(`admin.product.error.${result.error}`));
      return;
    }
    setError(null);
    const before = loaded.product ? { product: loaded.product, sizes: loaded.sizes } : null;
    if (isNew && ['food', 'keg'].includes(result.product.category_id)) result.product.stock_qty = null;
    await recordAdminEvent(db, ctx, { type: 'product_saved', payload: { ...result, before } });
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

  const saveCount = async () => {
    const n = Number((counting ?? '').replace(/[^0-9]/g, ''));
    if (!loaded.product || counting === null || counting.trim() === '' || !Number.isSafeInteger(n)) return;
    await recordAdminEvent(db, ctx, { type: 'shelf_counted', payload: { product_id: loaded.product.id, counted_qty: n, before_qty: loaded.product.stock_qty ?? 0 } });
    setCounting(null);
  };

  const bottles750 = product && ml && product.stock_qty !== null && product.stock_qty > 0 ? Math.round((product.stock_qty / 750) * 2) / 2 : null;

  return (
    <AdminLayout>
      <div className="a-title-row is-center">
        <div className="a-title-stack">
          <Link className="a-link a-link-sm" to="/admin/products">← {t('nav.products')}</Link>
          <h1>{isNew ? t('admin.product.new') : product?.name}</h1>
        </div>
        <div className="a-actions">
          <button type="button" className="a-btn" disabled={!dirty} onClick={() => { setDraft(null); setError(null); }}>{t('common.cancel')}</button>
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
            {product && d.stock_mode !== product.stock_mode && product.stock_qty !== null && <p className="a-note">{t('admin.product.modeChanged')}</p>}
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
                  </tr>
                </thead>
                <tbody>
                  {d.sizes.map((s, i) => (
                    <tr key={s.id}>
                      <td><input className="a-input" type="text" value={s.label} aria-label={t('admin.product.sizeLabelAria', { n: i + 1 })} onChange={(e) => editSize(i, { label: e.target.value })} /></td>
                      <td><input className="a-input is-num" type="text" inputMode="numeric" value={s.deduct[d.stock_mode]} aria-label={t('admin.product.deductAria', { size: s.label })} onChange={(e) => editSize(i, { deduct: { ...s.deduct, [d.stock_mode]: e.target.value.replace(/[^0-9]/g, '') } })} /></td>
                      <td><input className="a-input is-num is-strong" type="text" inputMode="numeric" value={s.price} aria-label={t('admin.product.priceAria', { size: s.label })} onChange={(e) => { const n = parseKes(e.target.value); editSize(i, { price: n === null ? '' : formatAmount(n) }); }} /></td>
                      <td>
                        <Switch on={s.enabled} label={t('admin.product.sellAria', { size: s.label })} onChange={(on) => editSize(i, { enabled: on })}>
                          <span className="a-switch-state">{s.enabled ? t('admin.on') : t('admin.off')}</span>
                        </Switch>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className="a-btn a-btn-dashed"
              onClick={() => edit({ sizes: [...d.sizes, { id: uuidv7(), label: '', label_sw: '', deduct: { count: '1', ml: '' }, price: '', enabled: true, sort: d.sizes.length, isNew: true }] })}
            >
              {t('product.addSize')}
            </button>
            <p className="a-info">{t('product.priceNote')}</p>
          </section>

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
          {product && tracked && (
            <section className="a-card">
              <h2>{t('product.inStock')}</h2>
              <div className={`a-stock-big${isNegativeStock(product) ? ' is-neg' : ''}`}>{stockText(product, t)}</div>
              <div className="a-note">
                {[bottles750 !== null ? t('admin.product.about750', { n: bottles750 }) : null,
                  product.low_stock_at !== null ? t('admin.product.alertBelow', { qty: stockText({ ...product, stock_qty: product.low_stock_at }, t) }) : null]
                  .filter(Boolean).join(' · ')}
              </div>
              <label className="a-field a-field-sm">
                {t('admin.product.alertLevel')}
                <input type="text" inputMode="numeric" value={d.low_stock_at} placeholder={t('admin.product.noAlert')} onChange={(e) => edit({ low_stock_at: e.target.value.replace(/[^0-9]/g, '') })} />
              </label>
              {counting === null ? (
                <div className="a-actions">
                  <Link className="a-btn a-btn-primary a-btn-sm" to={`/admin/stock/new?product=${product.id}`}>{t('action.addStock')}</Link>
                  <button type="button" className="a-btn a-btn-sm" onClick={() => setCounting('')}>{t('product.countShelf')}</button>
                </div>
              ) : (
                <div className="a-count">
                  <label className="a-field a-field-sm">
                    {t('admin.product.countedLabel', { unit: product.stock_mode === 'ml' ? 'ml' : t('admin.unit.bottles') })}
                    <input type="text" inputMode="numeric" autoFocus value={counting} onChange={(e) => setCounting(e.target.value.replace(/[^0-9]/g, ''))} />
                  </label>
                  <div className="a-actions">
                    <button type="button" className="a-btn a-btn-primary a-btn-sm" disabled={counting === ''} onClick={saveCount}>{t('admin.product.saveCount')}</button>
                    <button type="button" className="a-btn a-btn-sm" onClick={() => setCounting(null)}>{t('common.cancel')}</button>
                  </div>
                </div>
              )}
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
