import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { useQuery } from '../data/react';
import { isAgeing, orderDue, orderTotal, paidTotal } from '../domain/orders';
import { minutesBetween } from '../domain/time';
import { useI18n } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import { displayLabel } from './labels';
import { useSession } from './Session';
import { BackBar, Toast, toastFromState, useNow } from './ui';
import type { ToastMessage } from './ui';

type Filter = 'all' | 'mine' | 'old';

/** Screen 3: what is still to collect, oldest first. Rules R-ORD-1, R-ORD-2. */
export function OrdersScreen() {
  const { t } = useI18n();
  const { person } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>('all');
  const [toast, setToast] = useState<ToastMessage | null>(() => toastFromState(location.state));
  const clearToast = useCallback(() => setToast(null), []);

  const data = useQuery(async (d) => {
    const [bar, orders, people] = await Promise.all([
      d.bar.toCollection().first(),
      d.orders.where('status').equals('open').toArray(),
      d.people.toArray(),
    ]);
    const ids = orders.map((o) => o.id);
    const [lines, payments] = await Promise.all([
      d.lines.where('order_id').anyOf(ids).toArray(),
      d.payments.where('order_id').anyOf(ids).toArray(),
    ]);
    return { bar, orders, people, lines, payments };
  });
  if (!data || !person) return null;

  const ageingMinutes = data.bar?.ageing_minutes ?? 30;
  const cards = data.orders
    .map((order) => {
      const lines = data.lines.filter((l) => l.order_id === order.id);
      const payments = data.payments.filter((p) => p.order_id === order.id);
      const total = orderTotal(lines);
      const paid = paidTotal(payments);
      return {
        order,
        total,
        paid,
        due: orderDue(lines, payments),
        items: lines.reduce((sum, l) => (l.status === 'voided' ? sum : sum + l.qty), 0),
        minutes: minutesBetween(order.created_at, now),
        old: isAgeing(order, now, ageingMinutes),
        // Mine = handed over to me, or I served or recorded it and did not hand it over.
        mine: order.handed_over_to ? order.handed_over_to === person.id : order.server_id === person.id || order.recorded_by === person.id,
        server: order.server_id === person.id ? t('common.me') : (data.people.find((p) => p.id === order.server_id)?.name ?? ''),
      };
    })
    .sort((a, b) => a.order.created_at.localeCompare(b.order.created_at));

  const shown = cards.filter((c) => (filter === 'mine' ? c.mine : filter === 'old' ? c.old : true));
  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: t('orders.filterAll', { count: cards.length }) },
    { id: 'mine', label: t('orders.filterMine', { count: cards.filter((c) => c.mine).length }) },
    { id: 'old', label: t('orders.filterOld', { count: cards.filter((c) => c.old).length }) },
  ];

  return (
    <div className="c-screen">
      <BackBar to="/counter/sell" title={t('orders.title')} />

      <div className="c-orders-summary">
        <span>{t('orders.toCollect', { count: cards.length })}</span>
        <strong>{formatKES(cards.reduce((sum, c) => sum + c.due, 0))}</strong>
      </div>

      <div className="c-tabs">
        {filters.map((f) => (
          <button key={f.id} type="button" className="c-tab" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      <main className="c-body c-order-list">
        {shown.map((c) => {
          const part = c.paid > 0;
          return (
            <Link key={c.order.id} to={`/counter/orders/${c.order.id}`} className={`c-order-card${c.old ? ' is-old' : ''}`}>
              <span className="c-order-card-top">
                <strong>
                  {displayLabel(c.order.label, t)}
                  {c.order.note && <span className="c-order-card-note">{c.order.note}</span>}
                </strong>
                <span className="c-order-card-amount">{part ? t('orders.left', { amount: formatKES(c.due) }) : formatKES(c.due)}</span>
              </span>
              {part && (
                <span className="c-progress">
                  <span style={{ width: `${Math.round((c.paid / c.total) * 100)}%` }} />
                </span>
              )}
              <span className="c-order-card-bottom">
                <span className="c-order-card-meta">
                  {c.order.short_no} · {c.server} ·{' '}
                  {part
                    ? t('orders.paidOf', { paid: formatKES(c.paid), total: formatAmount(c.total) })
                    : t('common.items', { count: c.items })}
                </span>
                <span className={`c-time-chip${c.old ? ' is-old' : ''}`}>
                  <Icon name={part && !c.old ? 'pie' : 'clock'} size={16} strokeWidth={2.4} />
                  {c.old
                    ? t('orders.openLong', { count: c.minutes })
                    : part
                      ? t('orders.partPaidChip', { count: c.minutes })
                      : t('common.minutes', { count: c.minutes })}
                </span>
              </span>
            </Link>
          );
        })}

        {shown.length === 0 && (
          <div className="c-empty">
            <svg width="64" height="64" viewBox="0 0 72 72" fill="none" stroke="var(--k-text-3)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8h36v56l-6-4-6 4-6-4-6 4-6-4-6 4z M27 24h18 M27 34h18" />
              <path d="M26 46l6 6 14-14" stroke="var(--k-paid)" />
            </svg>
            <strong>{t('orders.empty')}</strong>
            <p>{cards.length === 0 ? t('orders.emptyBody') : t('orders.emptyFilter')}</p>
          </div>
        )}
      </main>

      <footer className="c-bottom">
        <button type="button" className="c-btn c-btn-primary" onClick={() => navigate('/counter/sell')}>
          <Icon name="plus" size={22} strokeWidth={2.6} />
          {cards.length === 0 ? t('orders.goToSell') : t('orders.newOrder')}
        </button>
      </footer>

      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}
