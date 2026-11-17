import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { addItems, recordOrder } from '../data/commands';
import { useConnection, useDb, useQuery } from '../data/react';
import { nextShortNo } from '../domain/payments';
import { enabledSizes, isPerSize, isSellable, leftOf } from '../domain/stock';
import { businessDayOf } from '../domain/time';
import type { Id, PaymentMethod, Person, Product, ProductSize } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import { formatKES } from '../lib/money';
import { displayLabel, labelForTable, matchesSearch, productName, sizeLabel } from './labels';
import type { TableChoice } from './labels';
import { useSession } from './Session';
import { Avatar, Sheet, Toast, TopBar, withOffline } from './ui';
import type { ToastMessage } from './ui';
import { voidLines } from '../data/voids';
import { signInToAdminAs } from '../admin/bars';
import { useCounterBar } from './DemoCounterGate';

const TABLES = Array.from({ length: 12 }, (_, i) => `${i + 1}` as TableChoice);
const CATEGORY_KEY = {
  beer: 'sell.cat.beer',
  spirits: 'sell.cat.spirits',
  keg: 'sell.cat.keg',
  soft: 'sell.cat.soft',
  food: 'sell.cat.food',
} as const;

interface CartLine {
  size_id: Id;
  qty: number;
}

type SheetState =
  | { kind: 'size'; productId: Id }
  | { kind: 'server' }
  | { kind: 'table' }
  | { kind: 'pay' }
  | { kind: 'order' }
  | { kind: 'me' }
  | null;

/** Screen 2: record a sale in 2 taps (pay later) or 3 (paid). Rules R-SELL-1…6. */
export function SellScreen() {
  const { t, locale } = useI18n();
  const db = useDb();
  const session = useSession();
  const navigate = useNavigate();
  const me = session.person!;
  const counterBar = useCounterBar();

  const [category, setCategory] = useState<Id | null>(null);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [table, setTable] = useState<TableChoice>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const recording = useRef(false);

  const categories = useQuery((d) => d.categories.orderBy('sort').toArray());
  // Counter order (as the admin arranged them), not alphabetical.
  const products = useQuery(async (d) => (await d.products.toArray()).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)));
  const sizes = useQuery((d) => d.sizes.toArray());
  const servers = useQuery(async (d) =>
    (await d.people.toArray()).filter((p) => (p.role === 'counter' || p.role === 'server') && !p.archived_at),
  );
  const openCount = useQuery((d) => d.orders.where('status').equals('open').count()) ?? 0;
  const orderNo = useQuery(async (d) => {
    const bar = await d.bar.toCollection().first();
    const today = await d.orders.where('business_day').equals(businessDayOf(new Date(), bar?.day_start)).toArray();
    return nextShortNo(today.map((o) => o.short_no));
  });

  const sizesByProduct = useMemo(() => {
    const map = new Map<Id, ProductSize[]>();
    for (const size of enabledSizes(sizes ?? [])) map.set(size.product_id, [...(map.get(size.product_id) ?? []), size]);
    return map;
  }, [sizes]);
  const sizeById = useMemo(() => new Map((sizes ?? []).map((s) => [s.id, s])), [sizes]);
  const productById = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);

  // "Add items" from Order detail opens Sell with ?order=<id>: the tray then adds to that order.
  const [params] = useSearchParams();
  const addToId = params.get('order');
  const target = useQuery(async (d) => (addToId ? ((await d.orders.get(addToId)) ?? null) : null), [addToId]);
  const { online } = useConnection();
  const offlineAware = (message: ToastMessage) => withOffline(message, online, t);

  // Signed out because their access was removed: the tray is saved as an open order (pay later) first.
  const unsaved = useRef<() => Promise<void>>(async () => undefined);
  const { registerSaver } = session;
  useEffect(() => registerSaver(() => unsaved.current()), [registerSaver]);

  const closeSheet = useCallback(() => setSheet(null), []);
  const clearToast = useCallback(() => setToast(null), []);

  if (!categories || !products || !sizes || !servers || target === undefined) return null;
  const adding = target?.status === 'open' ? target : null;

  const activeCategory = category ?? categories[0]?.id ?? null;
  const searching = query.trim().length > 0;
  const visible = products.filter(
    (p) =>
      !p.archived_at &&
      sizesByProduct.has(p.id) &&
      (searching ? matchesSearch(p, query) : p.category_id === activeCategory),
  );

  const qtyOfSize = (sizeId: Id) => cart.find((l) => l.size_id === sizeId)?.qty ?? 0;
  const qtyOfProduct = (productId: Id) =>
    cart.reduce((sum, l) => (sizeById.get(l.size_id)?.product_id === productId ? sum + l.qty : sum), 0);
  const bump = (sizeId: Id, delta: number) =>
    setCart((lines) => {
      const exists = lines.some((l) => l.size_id === sizeId);
      const next = exists
        ? lines.map((l) => (l.size_id === sizeId ? { ...l, qty: l.qty + delta } : l))
        : [...lines, { size_id: sizeId, qty: delta }];
      return next.filter((l) => l.qty > 0);
    });

  // R-SELL-1: one size adds straight away; several open the size picker.
  const tapProduct = (product: Product) => {
    const options = sizesByProduct.get(product.id) ?? [];
    if (options.length === 1) bump(options[0]!.id, 1);
    else setSheet({ kind: 'size', productId: product.id });
  };

  const rows = cart.flatMap((line) => {
    const size = sizeById.get(line.size_id);
    const product = size && productById.get(size.product_id);
    if (!size || !product) return [];
    const multi = (sizesByProduct.get(product.id)?.length ?? 0) > 1;
    return [{ line, size, product, multi, name: productName(product, locale), sum: size.price_kes * line.qty }];
  });
  const total = rows.reduce((sum, r) => sum + r.sum, 0);
  const count = rows.reduce((sum, r) => sum + r.line.qty, 0);
  const empty = count === 0;
  const summary = empty
    ? t('sell.emptyTray')
    : rows
        .map((r) => r.name + (r.multi ? ` ${sizeLabel(r.size, locale)}` : '') + (r.line.qty > 1 ? ` ×${r.line.qty}` : ''))
        .join(' · ');

  const server: Person = servers.find((p) => p.id === session.serverId) ?? me;
  const serverText = (p: Person) => (p.id === me.id ? t('common.me') : p.name);
  const tableText = displayLabel(labelForTable(table), t);

  unsaved.current = async () => {
    if (empty || recording.current) return;
    if (adding) await addItems(db, session.recordContext(), adding.id, cart);
    else await recordOrder(db, session.recordContext(), { label: labelForTable(table), server_id: server.id, items: cart });
    setCart([]);
  };

  const record = async (paidBy?: PaymentMethod) => {
    if (empty || recording.current) return;
    recording.current = true;
    try {
      if (adding) {
        await addItems(db, session.recordContext(), adding.id, cart);
        navigate(`/counter/orders/${adding.id}`, {
          replace: true,
          state: { toast: offlineAware({ text: t('sell.toastAdded', { count, no: adding.short_no }) }) },
        });
        return;
      }
      const order = await recordOrder(db, session.recordContext(), {
        label: labelForTable(table),
        server_id: server.id,
        items: cart,
        paid_by: paidBy,
      });
      // Lines clear and the table resets; the server stays (R-SELL-3).
      setCart([]);
      setTable(null);
      setSheet(null);
      const message: ToastMessage =
        paidBy
          ? {
              text: t('sell.toastPaid', {
                no: order.short_no,
                method: paidBy === 'cash' ? t('pay.cash').toLowerCase() : t('pay.mpesa'),
              }),
            }
          : {
              text: t('sell.toastLater', { no: order.short_no, label: tableText }),
              // Undo is a self-void of the whole order as "entered by mistake" (R-VOID-1).
              action: {
                label: t('common.undo'),
                run: () =>
                  void voidLines(db, session.recordContext(), {
                    order_id: order.id,
                    items: [],
                    whole_order: true,
                    reason: 'mistake',
                  }).then(() => setToast({ text: t('sell.toastUndone', { no: order.short_no }) })),
              },
            };
      setToast(offlineAware(message));
    } finally {
      recording.current = false;
    }
  };

  const sizeProduct = sheet?.kind === 'size' ? productById.get(sheet.productId) : undefined;

  return (
    <div className="c-screen">
      <TopBar
        trailing={
          <button
            type="button"
            className="c-icon-btn c-orders-btn"
            aria-label={`${t('sell.openOrders')} · ${openCount}`}
            onClick={() => navigate('/counter/orders')}
          >
            <Icon name="receipt" size={24} strokeWidth={2.1} />
            <span className="c-count-badge">{openCount}</span>
          </button>
        }
      >
        <button
          type="button"
          className="c-recorder"
          aria-label={`${t('sell.switchUser')} · ${me.name}`}
          onClick={() => setSheet({ kind: 'me' })}
        >
          <Avatar person={me} size={36} />
          <span>{me.name}</span>
        </button>
      </TopBar>

      <div className="c-search">
        <label>
          <Icon name="search" size={20} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sell.search')}
            aria-label={t('sell.search')}
          />
          {searching && (
            <button type="button" onClick={() => setQuery('')} aria-label={t('sell.clearSearch')}>
              <Icon name="close" size={20} strokeWidth={2.4} />
            </button>
          )}
        </label>
      </div>

      <div className="c-tabs" role="tablist">
        {categories.map((c) => {
          const selected = !searching && c.id === activeCategory;
          const key = CATEGORY_KEY[c.id as keyof typeof CATEGORY_KEY];
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className="c-tab"
              onClick={() => {
                setCategory(c.id);
                setQuery('');
              }}
            >
              {key ? t(key) : locale === 'sw' ? c.name_sw : c.name_en}
            </button>
          );
        })}
      </div>

      <main className="c-body c-grid-wrap">
        {searching && <p className="c-results-label">{t('sell.resultsFor', { query: query.trim() })}</p>}
        <div className="c-grid">
          {visible.map((product) => {
            const options = sizesByProduct.get(product.id)!;
            const name = productName(product, locale);
            if (!isSellable(product)) {
              return (
                <button key={product.id} type="button" className="c-tile is-out" disabled>
                  <span className="c-tile-name">{name}</span>
                  <span className="c-tile-out">
                    <Icon name="box" size={18} />
                    {t('status.outOfStock')}
                  </span>
                </button>
              );
            }
            const qty = qtyOfProduct(product.id);
            const multi = options.length > 1;
            // "N left" only while there is something left; a negative count is the admin's flag.
            // Stock per size: the one size's own stock (or the bottle it is poured from).
            const left = leftOf(product, options[0]!, sizes ?? []);
            const low = left !== null;
            return (
              <button
                key={product.id}
                type="button"
                className={`c-tile${qty > 0 ? ' is-in-order' : ''}`}
                aria-label={qty > 0 ? `${name}, ${t('sell.inOrder', { count: qty })}` : name}
                onClick={() => tapProduct(product)}
              >
                <span className="c-tile-name">{name}</span>
                {qty > 0 && <span className="c-tile-qty">{qty}</span>}
                {multi ? (
                  <span className="c-tile-multi">
                    <span className="c-tile-sizes">
                      <Icon name="list" size={16} />
                      {t('sell.sizes', { count: options.length })}
                    </span>
                    <span className="c-tile-from">
                      {t('sell.from', { price: formatKES(Math.min(...options.map((s) => s.price_kes))) })}
                    </span>
                  </span>
                ) : (
                  <span className="c-tile-single">
                    <span className="c-tile-price">{formatKES(options[0]!.price_kes)}</span>
                    {low ? (
                      <span className="c-tile-low">
                        <Icon name="alert-triangle" size={14} strokeWidth={2.6} />
                        {t('sell.left', { count: left! })}
                      </span>
                    ) : (
                      <span className="c-tile-size">{sizeLabel(options[0]!, locale)}</span>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {searching && visible.length === 0 && (
          <div className="c-no-results">
            <strong>{t('sell.noResults')}</strong>
            <p>{t('sell.noResultsHint')}</p>
          </div>
        )}
      </main>

      <footer className="c-tray">
        {adding ? (
          // The order already has its server and table; only what is added is new.
          <div className="c-adding">
            <span>{t('sell.addingTo', { order: `${displayLabel(adding.label, t)} ${adding.short_no}` })}</span>
            <button
              type="button"
              className="c-icon-btn"
              aria-label={t('common.cancel')}
              onClick={() => navigate(`/counter/orders/${adding.id}`)}
            >
              <Icon name="close" size={20} strokeWidth={2.4} />
            </button>
          </div>
        ) : (
          <div className="c-tray-chips">
            <button type="button" className="c-chip-btn c-chip-server" onClick={() => setSheet({ kind: 'server' })}>
              <Avatar person={server} size={30} />
              <span>{t('sell.serverChip', { name: serverText(server) })}</span>
              <Icon name="chevron-down" size={18} strokeWidth={2.4} />
            </button>
            <button type="button" className="c-chip-btn" onClick={() => setSheet({ kind: 'table' })}>
              <span>{tableText}</span>
              <Icon name="chevron-down" size={18} strokeWidth={2.4} />
            </button>
          </div>
        )}
        <button type="button" className="c-tray-summary" disabled={empty} onClick={() => setSheet({ kind: 'order' })}>
          <span className="c-tray-text">
            <span className="c-tray-count">
              {empty ? t('common.total') : t('common.items', { count })}
              {!empty && <Icon name="chevron-up" size={18} strokeWidth={2.4} />}
            </span>
            <span className="c-tray-items">{summary}</span>
          </span>
          <span className="c-tray-total">{formatKES(total)}</span>
        </button>
        <div className="c-tray-actions">
          {adding ? (
            // Payment for an existing order is taken on Order detail.
            <button type="button" className="c-btn c-btn-primary c-record" disabled={empty} onClick={() => void record()}>
              {t('sell.addToOrder', { no: adding.short_no })}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="c-btn c-btn-secondary c-record-paid"
                disabled={empty}
                onClick={() => setSheet({ kind: 'pay' })}
              >
                <Icon name="check-circle" size={22} />
                <span>{t('sell.recordPaid')}</span>
              </button>
              <button type="button" className="c-btn c-btn-primary c-record" disabled={empty} onClick={() => void record()}>
                {t('sell.record')}
              </button>
            </>
          )}
        </div>
      </footer>

      <Toast message={toast} onDone={clearToast} />

      {sizeProduct && (
        <Sheet title={productName(sizeProduct, locale)} subtitle={t('sell.pickSize')} onClose={closeSheet}>
          <div className="c-rows">
            {(sizesByProduct.get(sizeProduct.id) ?? []).map((size) => {
              const qty = qtyOfSize(size.id);
              const left = isPerSize(sizeProduct) ? leftOf(sizeProduct, size, sizes ?? []) : null;
              return (
                <button
                  key={size.id}
                  type="button"
                  className={`c-row c-size-row${qty > 0 ? ' is-on' : ''}`}
                  onClick={() => {
                    bump(size.id, 1);
                    setSheet(null);
                  }}
                >
                  <span className="c-size-label">
                    <strong>{sizeLabel(size, locale)}</strong>
                    {qty > 0 && <span className="c-in-order">{t('sell.inOrder', { count: qty })}</span>}
                    {left !== null && qty === 0 && (
                      <span className="c-tile-low">
                        <Icon name="alert-triangle" size={14} strokeWidth={2.6} />
                        {t('sell.left', { count: left })}
                      </span>
                    )}
                  </span>
                  <span className="c-size-price">{formatKES(size.price_kes)}</span>
                </button>
              );
            })}
          </div>
        </Sheet>
      )}

      {sheet?.kind === 'me' && (
        <Sheet title={me.name} subtitle={session.device?.name} onClose={closeSheet}>
          <button
            type="button"
            className="c-btn c-btn-secondary"
            onClick={() => {
              session.logout();
              navigate('/counter/login');
            }}
          >
            {t('sell.switchUser')}
          </button>
          <button type="button" className="c-btn c-btn-secondary" onClick={() => navigate('/counter/shift/close')}>
            {t('shift.title')}
          </button>
          {(me.role === 'owner' || me.role === 'admin') && (
            <button
              type="button"
              className="c-btn c-btn-secondary"
              onClick={() => {
                // Demo: their admin opens on this bar without signing in again.
                if (counterBar) signInToAdminAs(me.id, counterBar.bar.id);
                navigate('/admin');
              }}
            >
              {t('sell.toAdmin')}
            </button>
          )}
        </Sheet>
      )}

      {sheet?.kind === 'server' && (
        <Sheet title={t('sell.whoServes')} subtitle={t('sell.serverHint')} onClose={closeSheet}>
          <div className="c-rows">
            {[me, ...servers.filter((p) => p.id !== me.id)].map((p) => {
              const on = p.id === server.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`c-row c-server-row${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => {
                    session.setServerId(p.id);
                    setSheet(null);
                  }}
                >
                  <Avatar person={p} size={40} />
                  <span>{p.id === me.id ? `${t('common.me')} (${p.name})` : p.name}</span>
                  {on && <Icon name="check" size={24} strokeWidth={2.6} className="c-ember" />}
                </button>
              );
            })}
          </div>
        </Sheet>
      )}

      {sheet?.kind === 'table' && (
        <Sheet title={t('sell.tableTitle')} subtitle={t('sell.tableHint')} onClose={closeSheet}>
          <div className="c-table-grid">
            {TABLES.map((value) => (
              <TableButton key={value} value={value} current={table} label={value!} onPick={(v) => { setTable(v); setSheet(null); }} />
            ))}
          </div>
          <div className="c-table-extras">
            {(['counter', 'takeaway', null] as TableChoice[]).map((value) => (
              <TableButton
                key={value ?? 'none'}
                value={value}
                current={table}
                label={displayLabel(labelForTable(value), t)}
                onPick={(v) => { setTable(v); setSheet(null); }}
              />
            ))}
          </div>
        </Sheet>
      )}

      {sheet?.kind === 'pay' && (
        <Sheet title={t('sell.payTitle')} subtitle={`${orderNo ?? ''} · ${tableText} · ${server.name}`} onClose={closeSheet}>
          <div className="c-sheet-total">
            <span>{t('common.total')}</span>
            <strong>{formatKES(total)}</strong>
          </div>
          <div className="c-pay-grid">
            <button type="button" className="c-pay-btn" onClick={() => void record('cash')}>
              <Icon name="cash" size={28} strokeWidth={2} />
              {t('pay.cash')}
            </button>
            <button type="button" className="c-pay-btn" onClick={() => void record('mpesa')}>
              <Icon name="phone" size={28} strokeWidth={2} />
              {t('pay.mpesa')}
            </button>
          </div>
          <p className="c-sheet-hint">{t('sell.payHint')}</p>
          <button type="button" className="c-btn c-btn-link" onClick={closeSheet}>
            {t('common.cancel')}
          </button>
        </Sheet>
      )}

      {sheet?.kind === 'order' && !empty && (
        <Sheet
          title={`${t('sell.thisOrder')} · ${adding?.short_no ?? orderNo ?? ''}`}
          subtitle={`${tableText} · ${t('sell.serverChip', { name: server.name })}`}
          onClose={closeSheet}
        >
          <div className="c-rows">
            {rows.map((r) => (
              <div key={r.line.size_id} className="c-line-row">
                <div className="c-line-text">
                  <strong>{r.name}</strong>
                  <span>
                    {sizeLabel(r.size, locale)} · {formatKES(r.size.price_kes)} {t('common.each')} · {formatKES(r.sum)}
                  </span>
                </div>
                <button
                  type="button"
                  className="c-icon-btn"
                  aria-label={`${t('sell.removeOne')}: ${r.name}`}
                  onClick={() => {
                    if (count === 1) setSheet(null);
                    bump(r.line.size_id, -1);
                  }}
                >
                  <Icon name="minus" size={20} strokeWidth={2.6} />
                </button>
                <span className="c-line-qty">{r.line.qty}</span>
                <button type="button" className="c-icon-btn" aria-label={`${t('sell.addOne')}: ${r.name}`} onClick={() => bump(r.line.size_id, 1)}>
                  <Icon name="plus" size={20} strokeWidth={2.6} />
                </button>
              </div>
            ))}
          </div>
          <div className="c-sheet-total">
            <span>{t('common.total')}</span>
            <strong>{formatKES(total)}</strong>
          </div>
          <button
            type="button"
            className="c-btn c-btn-danger"
            onClick={() => {
              setCart([]);
              setSheet(null);
            }}
          >
            {t('sell.clearOrder')}
          </button>
        </Sheet>
      )}
    </div>
  );
}

interface TableButtonProps {
  value: TableChoice;
  current: TableChoice;
  label: string;
  onPick: (value: TableChoice) => void;
}

function TableButton({ value, current, label, onPick }: TableButtonProps) {
  const on = value === current;
  return (
    <button type="button" className={`c-table-btn${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => onPick(value)}>
      {label}
    </button>
  );
}
