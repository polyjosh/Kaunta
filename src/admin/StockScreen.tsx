import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { productName, sizeLabel } from '../counter/labels';
import { recordAdminEvent } from '../data/adminEvents';
import { useDb, useQuery } from '../data/react';
import { mugSize } from '../domain/admin';
import { uuidv7 } from '../domain/ids';
import { deliveryTotal, isPerSize, stockedSizes } from '../domain/stock';
import type { Keg, Pack, Product, ProductSize } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import type { TFunction } from '../lib/I18nProvider';
import { formatAmount } from '../lib/money';
import { AdminLayout, PageTitle } from './AdminLayout';
import { useAdmin, useNow } from './AdminSession';
import { hhmm } from './data';

export interface Container {
  key: string;
  label: string;
  /** Units or ml in one. */
  per: number;
  /** Stock per size: the size whose stock it goes into. */
  size_id?: string | null;
}

const KEG_ML = 50_000;

export const isKegProduct = (p: Pick<Product, 'category_id'>) => p.category_id === 'keg';

/** The usual packs before an owner sets their own: crates of 24 and 25 for counted things, none for spirits. */
export function defaultPacks(product: Pick<Product, 'stock_mode' | 'category_id'>, t: TFunction): Pack[] {
  if (product.stock_mode === 'ml' || isKegProduct(product)) return [];
  return [
    { id: 'crate24', label: t('admin.stock.crate', { count: 24 }), count: 24 },
    { id: 'crate25', label: t('admin.stock.crate', { count: 25 }), count: 25 },
  ];
}

export const packsOf = (product: Product, t: TFunction): Pack[] => product.packs ?? defaultPacks(product, t);

/** Sizes that are whole bottles (250 ml and up), largest first: what spirits arrive as. */
export const bottleSizes = (product: Pick<Product, 'id'>, sizes: readonly ProductSize[]) =>
  sizes.filter((s) => s.product_id === product.id && !s.archived_at && s.deduct >= 250).sort((a, b) => b.deduct - a.deduct);

/** "Box of 12 (12 × 750ml)" in ml mode; the owner's own words in count mode. */
export function packLabel(pack: Pack, size: Pick<ProductSize, 'label_en'> | undefined): string {
  return size ? `${pack.label} (${pack.count} × ${size.label_en})` : pack.label;
}

/** How a product can arrive (R-STOCK-2): bottles by size and packs of them for spirits, packs or singles for counted things, kegs. */
export function containersFor(product: Product, sizes: readonly ProductSize[], t: TFunction): Container[] {
  if (isKegProduct(product)) return [{ key: 'keg50', label: t('admin.stock.keg', { litres: KEG_ML / 1000, mugs: KEG_ML / 500 }), per: KEG_ML }];
  const bySize = isPerSize(product) ? sizeContainers(product, sizes, t) : [];
  if (bySize.length > 0) return bySize;
  if (product.stock_mode === 'ml') {
    const bottles = bottleSizes(product, sizes);
    return [
      ...bottles.map((s) => ({ key: s.id, label: t('admin.stock.bottle', { size: s.label_en }), per: s.deduct })),
      ...packsOf(product, t).flatMap((p) => {
        const size = bottles.find((s) => s.id === p.size_id);
        return size ? [{ key: p.id, label: packLabel(p, size), per: p.count * size.deduct }] : [];
      }),
    ];
  }
  return [
    ...packsOf(product, t).map((p) => ({ key: p.id, label: p.label, per: p.count })),
    { key: 'single', label: t('admin.stock.single'), per: 1 },
  ];
}

/** Stock per size: each size that keeps its own stock arrives as itself and in its packs. */
function sizeContainers(product: Product, sizes: readonly ProductSize[], t: TFunction): Container[] {
  const pools = stockedSizes(product, sizes);
  const packs = packsOf(product, t);
  // A pack of a size without its own stock (or of none, for counted things) is of the largest size.
  const poolOf = (p: Pack) => pools.find((s) => s.id === p.size_id) ?? (product.stock_mode === 'count' ? pools[0] : undefined);
  return pools.flatMap((size) => {
    const own = packs.filter((p) => poolOf(p)?.id === size.id);
    if (product.stock_mode === 'ml') {
      return [
        { key: size.id, label: t('admin.stock.bottle', { size: size.label_en }), per: size.deduct, size_id: size.id },
        ...own.map((p) => ({ key: p.id, label: packLabel(p, size), per: p.count * size.deduct, size_id: size.id })),
      ];
    }
    const many = pools.length > 1;
    return [
      ...own.map((p) => ({ key: p.id, label: many ? packLabel(p, size) : p.label, per: p.count * size.deduct, size_id: size.id })),
      { key: `single:${size.id}`, label: many ? t('admin.stock.singleSize', { size: size.label_en }) : t('admin.stock.single'), per: size.deduct, size_id: size.id },
    ];
  });
}

function defaultContainer(product: Product, options: Container[]): Container {
  if (product.stock_mode === 'ml') return options.find((o) => o.per === 750) ?? options[0]!;
  if (product.category_id === 'beer') return options.find((o) => o.key === 'crate25') ?? options[0]!;
  if (product.category_id === 'soft') return options.find((o) => o.key === 'crate24') ?? options[0]!;
  return options[0]!;
}

/** "2.25 L (2,250 ml)", "25 bottles". */
export function amountText(amount: number, mode: Product['stock_mode'], t: TFunction): string {
  if (mode === 'ml') return amount >= 1000 ? `${String(amount / 1000)} L (${formatAmount(amount)} ml)` : `${formatAmount(amount)} ml`;
  return `${formatAmount(amount)} ${t('admin.unit.bottles')}`;
}

const signed = (n: number) => `${n < 0 ? '−' : ''}${formatAmount(Math.abs(n))}`;

interface Row {
  /** Stable while lines are removed. */
  key: number;
  product_id: string;
  container: string;
  qty: number;
}

const NEW_PACK = '__new_pack';
const MAX_QTY = 9999;

/** A pack the owner adds while entering a delivery ("Box of 12"); it is kept on the product. */
function NewPackForm({ product, sizes, onSave, onCancel }: { product: Product; sizes: ProductSize[]; onSave: (pack: Pack) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const ml = product.stock_mode === 'ml';
  const perSize = isPerSize(product);
  const bottles = perSize ? stockedSizes(product, sizes) : bottleSizes(product, sizes);
  const pickSize = ml || perSize;
  const [label, setLabel] = useState('');
  const [count, setCount] = useState('');
  const [sizeId, setSizeId] = useState(bottles.find((s) => s.deduct === 750)?.id ?? bottles[0]?.id ?? '');
  const n = Number(count);
  const ok = label.trim() !== '' && Number.isSafeInteger(n) && n > 1 && (!pickSize || sizeId !== '');
  return (
    <div className="a-packform" role="group" aria-label={t('admin.stock.newPackTitle', { name: product.name })}>
      <label className="a-field a-field-sm">
        {t('admin.pack.label')}
        <input type="text" autoFocus value={label} placeholder={t('admin.pack.labelHint')} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="a-field a-field-sm">
        {t('admin.pack.count')}
        <input type="text" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} />
      </label>
      {pickSize && (
        <label className="a-field a-field-sm">
          {t('admin.pack.bottle')}
          <select value={sizeId} onChange={(e) => setSizeId(e.target.value)}>
            {bottles.map((s) => <option key={s.id} value={s.id}>{s.label_en}</option>)}
          </select>
        </label>
      )}
      <div className="a-actions">
        <button type="button" className="a-btn a-btn-primary a-btn-sm" disabled={!ok} onClick={() => onSave({ id: uuidv7(), label: label.trim(), count: n, size_id: pickSize ? sizeId : null })}>{t('admin.pack.save')}</button>
        <button type="button" className="a-btn a-btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      <p className="a-note">{t('admin.pack.kept')}</p>
    </div>
  );
}

/** Add stock (Stock.dc.html): containers in, totals worked out (R-STOCK-2…4). */
export function StockScreen() {
  const { t, locale } = useI18n();
  const db = useDb();
  const { ctx, person, now } = useAdmin();
  const clock = useNow();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const data = useQuery(async (d) => ({ products: await d.products.toArray(), sizes: await d.sizes.toArray(), kegs: await d.kegs.toArray() }));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [supplier, setSupplier] = useState('');
  const [noteNo, setNoteNo] = useState('');
  const [picking, setPicking] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [newPackFor, setNewPackFor] = useState<number | null>(null);
  const [nextKey, setNextKey] = useState(1);

  if (!data) return <AdminLayout>{null}</AdminLayout>;
  const stockable = data.products.filter((p) => !p.archived_at && (p.stock_qty !== null || isKegProduct(p)));
  const byId = new Map(data.products.map((p) => [p.id, p]));
  const newRow = (p: Product, key: number): Row => {
    const options = containersFor(p, data.sizes, t);
    return { key, product_id: p.id, container: defaultContainer(p, options).key, qty: 1 };
  };
  const preset = params.get('product');
  const current = rows ?? (preset && byId.get(preset) ? [newRow(byId.get(preset)!, 0)] : []);
  const update = (i: number, patch: Partial<Row>) => setRows(current.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => {
    setNewPackFor(null);
    setRows(current.filter((_, j) => j !== i));
  };
  const savePack = async (i: number, product: Product, pack: Pack) => {
    const sizes = data.sizes.filter((s) => s.product_id === product.id);
    await recordAdminEvent(db, ctx, {
      type: 'product_saved',
      payload: { product: { ...product, packs: [...packsOf(product, t), pack] }, sizes, before: { product, sizes } },
    });
    setNewPackFor(null);
    update(i, { container: pack.id });
  };

  const lines = current.map((r) => {
    const product = byId.get(r.product_id)!;
    const options = containersFor(product, data.sizes, t);
    const container = options.find((o) => o.key === r.container) ?? options[0]!;
    const total = deliveryTotal(r.qty, container.per);
    // The stock it adds to: that size's own (stock per size), or the product's.
    const pool = container.size_id ? data.sizes.find((s) => s.id === container.size_id) : undefined;
    const before = pool ? (pool.stock_qty ?? 0) : (product.stock_qty ?? 0);
    const name = pool ? `${productName(product, locale)} ${sizeLabel(pool, locale)}` : productName(product, locale);
    return { row: r, product, options, container, total, before, name, keg: isKegProduct(product) };
  });
  const chosen = lines.filter((l) => l.row.qty > 0);
  const cleared = chosen.filter((l) => !l.keg && l.product.stock_qty !== null && l.before < 0 && l.before + l.total >= 0);
  const kegs = chosen.filter((l) => l.keg).reduce((n, l) => n + l.row.qty, 0);

  const submit = async () => {
    if (chosen.length === 0) return;
    const at = now().toISOString();
    const id = uuidv7(now().getTime());
    const newKegs: Keg[] = [];
    let next = Math.max(0, ...data.kegs.map((k) => Number(/(\d+)$/.exec(k.code)?.[1] ?? 0)));
    for (const l of chosen.filter((x) => x.keg)) {
      const mug = mugSize({ product_id: l.product.id, cup_ml: 500 }, data.sizes) ?? data.sizes.filter((s) => s.product_id === l.product.id).sort((a, b) => a.deduct - b.deduct)[0];
      for (let i = 0; i < l.row.qty; i++) {
        next += 1;
        newKegs.push({
          id: uuidv7(now().getTime()), product_id: l.product.id, code: `K-${String(next).padStart(2, '0')}`, volume_ml: l.container.per,
          cup_ml: mug?.deduct ?? 500, status: 'queued', tapped_at: null, finished_at: null, finished_by: null, recorded_ml_baseline: 0,
        });
      }
    }
    await recordAdminEvent(db, ctx, {
      type: 'delivery_recorded',
      payload: {
        delivery: {
          id, supplier: supplier.trim() || null, note_no: noteNo.trim() || null, received_by: person.id, created_at: at, keg_ids: newKegs.map((k) => k.id),
          // Kegs go to the queue, not the shelf (R-STOCK-4), so they carry no shelf line.
          lines: chosen.filter((l) => !l.keg).map((l) => ({ product_id: l.product.id, size_id: l.container.size_id ?? null, container_label: l.container.label, container_qty: l.row.qty, per_container: l.container.per, total: l.total })),
        },
        kegs: newKegs,
      },
    });
    setRows([]);
    setSupplier('');
    setNoteNo('');
    setDone(t('admin.stock.done', { count: chosen.length }));
    navigate('/admin/stock/new', { replace: true });
  };

  return (
    <AdminLayout>
      <PageTitle title={t('stock.title')} aside={t('stock.subtitle')} />
      {done && <p className="a-ok" role="status"><Icon name="check" size={18} /> {done}</p>}
      <div className="a-row is-top">
        <section className="a-card a-grow-main">
          <div className="a-fields">
            <label className="a-field">
              <span>{t('stock.supplier')} <span className="a-field-hint is-inline">{t('common.optional')}</span></span>
              <input type="text" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </label>
            <label className="a-field">
              <span>{t('stock.noteNo')} <span className="a-field-hint is-inline">{t('common.optional')}</span></span>
              <input type="text" value={noteNo} onChange={(e) => setNoteNo(e.target.value)} />
            </label>
            <div className="a-field">
              {t('stock.receivedBy')}
              <div className="a-readonly">{t('admin.stock.receivedAt', { name: person.name, time: hhmm(clock.toISOString()) })}</div>
            </div>
          </div>

          {lines.map((l, i) => (
            <div key={l.row.key} className="a-srow">
              <div className="a-srow-what">
                <strong>{productName(l.product, locale)}</strong>
                {l.keg ? (
                  <span>{l.container.label}</span>
                ) : (
                  <select
                    className="a-select-sm"
                    value={l.container.key}
                    aria-label={t('admin.stock.containerAria', { name: l.product.name })}
                    onChange={(e) => (e.target.value === NEW_PACK ? setNewPackFor(l.row.key) : update(i, { container: e.target.value }))}
                  >
                    {l.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                    <option value={NEW_PACK}>{t('admin.stock.newPack')}</option>
                  </select>
                )}
              </div>
              <div className="a-stepper">
                <button type="button" aria-label={t('admin.stock.less', { what: l.container.label })} disabled={l.row.qty === 0} onClick={() => update(i, { qty: Math.max(0, l.row.qty - 1) })}>−</button>
                <span className="a-stepper-x" aria-hidden="true">×</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="a-stepper-qty"
                  value={l.row.qty === 0 ? '' : String(l.row.qty)}
                  placeholder="0"
                  aria-label={t('admin.stock.qtyAria', { what: l.container.label, name: l.product.name })}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => update(i, { qty: Math.min(MAX_QTY, Number(e.target.value.replace(/[^0-9]/g, '') || 0)) })}
                />
                <button type="button" aria-label={t('admin.stock.more', { what: l.container.label })} disabled={l.row.qty >= MAX_QTY} onClick={() => update(i, { qty: l.row.qty + 1 })}>+</button>
              </div>
              <div className="a-srow-total">
                <strong>= {amountText(l.total, l.keg ? 'ml' : l.product.stock_mode, t)}</strong>
                {l.keg ? (
                  <span>{t('stock.toKegQueue')}</span>
                ) : (
                  <span className={l.before < 0 && l.before + l.total >= 0 ? 'is-fix' : ''}>
                    {l.container.size_id && <>{sizeLabel(data.sizes.find((s) => s.id === l.container.size_id)!, locale)}: </>}
                    {t('stock.now', { before: signed(l.before), after: signed(l.before + l.total), unit: l.product.stock_mode === 'ml' ? 'ml' : t('admin.unit.bottles') })}
                  </span>
                )}
              </div>
              <button type="button" className="a-btn a-btn-sm a-srow-remove" aria-label={t('admin.stock.removeAria', { name: productName(l.product, locale) })} onClick={() => remove(i)}>
                <Icon name="close" size={16} /> {t('admin.stock.remove')}
              </button>
              {newPackFor === l.row.key && (
                <NewPackForm product={l.product} sizes={data.sizes} onSave={(pack) => savePack(i, l.product, pack)} onCancel={() => setNewPackFor(null)} />
              )}
            </div>
          ))}

          {picking ? (
            <label className="a-field a-field-sm">
              {t('admin.stock.pick')}
              <select
                autoFocus
                value=""
                onChange={(e) => {
                  const p = byId.get(e.target.value);
                  if (p) {
                    setRows([...current, newRow(p, nextKey)]);
                    setNextKey(nextKey + 1);
                  }
                  setPicking(false);
                }}
                onBlur={() => setPicking(false)}
              >
                <option value="" disabled>{t('admin.stock.choose')}</option>
                {stockable.sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.id} value={p.id}>{productName(p, locale)}</option>)}
              </select>
            </label>
          ) : (
            <button type="button" className="a-btn a-btn-dashed" onClick={() => { setDone(null); setPicking(true); }}>{t('stock.addProduct')}</button>
          )}
        </section>

        <aside className="a-col a-grow-side">
          <section className="a-card">
            <h2>{t('stock.thisDelivery')}</h2>
            {chosen.length === 0 && <p className="a-muted">{t('admin.stock.nothingYet')}</p>}
            {chosen.map((l, i) => (
              <div key={i} className="a-legend is-sm">
                <span>{l.name}</span>
                <strong>{amountText(l.total, l.keg ? 'ml' : l.product.stock_mode, t)}</strong>
              </div>
            ))}
            {cleared.map((l) => (
              <p key={l.row.key} className="a-ok-note">
                {t('admin.stock.clears', { name: l.name, before: signed(l.before), after: signed(l.before + l.total) })}
              </p>
            ))}
            {kegs > 0 && (
              <p className="a-info">
                {t('admin.stock.kegNote')} <Link to="/admin/kegs">{t('admin.stock.seeKegs')}</Link>
              </p>
            )}
            <button type="button" className="a-btn a-btn-primary a-btn-lg" disabled={chosen.length === 0} onClick={submit}>{t('stock.submit')}</button>
            <p className="a-note">{t('admin.stock.audit')}</p>
          </section>
        </aside>
      </div>
    </AdminLayout>
  );
}
