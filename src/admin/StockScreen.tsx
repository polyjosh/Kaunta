import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { productName } from '../counter/labels';
import { recordAdminEvent } from '../data/adminEvents';
import { useDb, useQuery } from '../data/react';
import { mugSize } from '../domain/admin';
import { uuidv7 } from '../domain/ids';
import { deliveryTotal } from '../domain/stock';
import type { Keg, Product, ProductSize } from '../domain/types';
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
}

const KEG_ML = 50_000;

export const isKegProduct = (p: Pick<Product, 'category_id'>) => p.category_id === 'keg';

/** How a product can arrive (R-STOCK-2): bottles by size for spirits, crates or singles for counted things, kegs. */
export function containersFor(product: Product, sizes: readonly ProductSize[], t: TFunction): Container[] {
  if (isKegProduct(product)) return [{ key: 'keg50', label: t('admin.stock.keg', { litres: KEG_ML / 1000, mugs: KEG_ML / 500 }), per: KEG_ML }];
  if (product.stock_mode === 'ml') {
    return sizes
      .filter((s) => s.product_id === product.id && s.deduct >= 250)
      .sort((a, b) => b.deduct - a.deduct)
      .map((s) => ({ key: s.id, label: t('admin.stock.bottle', { size: s.label_en }), per: s.deduct }));
  }
  return [
    { key: 'crate24', label: t('admin.stock.crate', { count: 24 }), per: 24 },
    { key: 'crate25', label: t('admin.stock.crate', { count: 25 }), per: 25 },
    { key: 'single', label: t('admin.stock.single'), per: 1 },
  ];
}

function defaultContainer(product: Product, options: Container[]): Container {
  if (product.stock_mode === 'ml') return options.find((o) => o.per === 750) ?? options[0]!;
  if (product.category_id === 'beer') return options.find((o) => o.key === 'crate25')!;
  if (product.category_id === 'soft') return options.find((o) => o.key === 'crate24')!;
  return options[0]!;
}

/** "2.25 L (2,250 ml)", "25 bottles". */
export function amountText(amount: number, mode: Product['stock_mode'], t: TFunction): string {
  if (mode === 'ml') return amount >= 1000 ? `${String(amount / 1000)} L (${formatAmount(amount)} ml)` : `${formatAmount(amount)} ml`;
  return `${formatAmount(amount)} ${t('admin.unit.bottles')}`;
}

const signed = (n: number) => `${n < 0 ? '−' : ''}${formatAmount(Math.abs(n))}`;

interface Row {
  product_id: string;
  container: string;
  qty: number;
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

  if (!data) return <AdminLayout>{null}</AdminLayout>;
  const stockable = data.products.filter((p) => !p.archived_at && (p.stock_qty !== null || isKegProduct(p)));
  const byId = new Map(data.products.map((p) => [p.id, p]));
  const newRow = (p: Product): Row => {
    const options = containersFor(p, data.sizes, t);
    return { product_id: p.id, container: defaultContainer(p, options).key, qty: 1 };
  };
  const preset = params.get('product');
  const current = rows ?? (preset && byId.get(preset) ? [newRow(byId.get(preset)!)] : []);
  const update = (i: number, patch: Partial<Row>) => setRows(current.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const lines = current.map((r) => {
    const product = byId.get(r.product_id)!;
    const options = containersFor(product, data.sizes, t);
    const container = options.find((o) => o.key === r.container) ?? options[0]!;
    const total = deliveryTotal(r.qty, container.per);
    return { row: r, product, options, container, total, keg: isKegProduct(product) };
  });
  const chosen = lines.filter((l) => l.row.qty > 0);
  const cleared = chosen.filter((l) => !l.keg && l.product.stock_qty !== null && l.product.stock_qty < 0 && l.product.stock_qty + l.total >= 0);
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
          lines: chosen.filter((l) => !l.keg).map((l) => ({ product_id: l.product.id, container_label: l.container.label, container_qty: l.row.qty, per_container: l.container.per, total: l.total })),
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
            <div key={`${l.row.product_id}-${i}`} className="a-srow">
              <div className="a-srow-what">
                <strong>{productName(l.product, locale)}</strong>
                {l.options.length > 1 ? (
                  <select className="a-select-sm" value={l.container.key} aria-label={t('admin.stock.containerAria', { name: l.product.name })} onChange={(e) => update(i, { container: e.target.value })}>
                    {l.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                ) : (
                  <span>{l.container.label}</span>
                )}
              </div>
              <div className="a-stepper">
                <button type="button" aria-label={t('admin.stock.less', { what: l.container.label })} disabled={l.row.qty === 0} onClick={() => update(i, { qty: Math.max(0, l.row.qty - 1) })}>−</button>
                <span aria-live="polite">× {l.row.qty}</span>
                <button type="button" aria-label={t('admin.stock.more', { what: l.container.label })} onClick={() => update(i, { qty: l.row.qty + 1 })}>+</button>
              </div>
              <div className="a-srow-total">
                <strong>= {amountText(l.total, l.keg ? 'ml' : l.product.stock_mode, t)}</strong>
                {l.keg ? (
                  <span>{t('stock.toKegQueue')}</span>
                ) : (
                  <span className={l.product.stock_qty! < 0 && l.product.stock_qty! + l.total >= 0 ? 'is-fix' : ''}>
                    {t('stock.now', { before: signed(l.product.stock_qty!), after: signed(l.product.stock_qty! + l.total), unit: l.product.stock_mode === 'ml' ? 'ml' : t('admin.unit.bottles') })}
                  </span>
                )}
              </div>
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
                  if (p) setRows([...current, newRow(p)]);
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
                <span>{productName(l.product, locale)}</span>
                <strong>{amountText(l.total, l.keg ? 'ml' : l.product.stock_mode, t)}</strong>
              </div>
            ))}
            {cleared.map((l) => (
              <p key={l.product.id} className="a-ok-note">
                {t('admin.stock.clears', { name: productName(l.product, locale), before: signed(l.product.stock_qty!), after: signed(l.product.stock_qty! + l.total) })}
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
