import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusChip } from '../components/StatusChip';
import { useQuery } from '../data/react';
import { openShiftOf } from '../data/shifts';
import { inFilter, shiftSales } from '../domain/shiftSales';
import type { SalesFilter, ShiftSale } from '../domain/shiftSales';
import type { Id } from '../domain/types';
import { localTime } from '../domain/time';
import { useI18n } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import type { MessageKey } from '../lib/i18n';
import { displayLabel } from './labels';
import { useSession } from './Session';
import { BackBar } from './ui';

const FILTERS: readonly SalesFilter[] = ['all', 'pending', 'paid', 'cancelled'];

/**
 * Every sale this person made in their open shift on this phone, newest
 * first: still to collect, paid, and voided (with where an admin's decision
 * on the void stands). Tapping one opens the order.
 */
export function ShiftSalesScreen() {
  const { t } = useI18n();
  const session = useSession();
  const me = session.person;
  const deviceId = session.device?.id;
  const [filter, setFilter] = useState<SalesFilter>('all');

  const data = useQuery(
    async (d) => {
      const shift = me && deviceId ? ((await openShiftOf(d, me.id, deviceId)) ?? null) : null;
      if (!shift || !me) return null;
      const orders = await d.orders.toArray();
      const ids = orders.map((o) => o.id);
      const [lines, payments, approvals, people] = await Promise.all([
        d.lines.where('order_id').anyOf(ids).toArray(),
        d.payments.where('order_id').anyOf(ids).toArray(),
        d.approvals.filter((a) => a.kind === 'void' || a.kind === 'write_off').toArray(),
        d.people.toArray(),
      ]);
      return { shift, sales: shiftSales(shift, me.id, orders, lines, payments, approvals), people };
    },
    [me?.id, deviceId],
  );
  if (!me || data === undefined) return null;
  if (data === null) {
    return (
      <div className="c-screen">
        <BackBar to="/counter/sell" title={t('sales.title')} />
        <main className="c-body c-locked">
          <div className="c-locked-card">
            <p className="c-locked-body">
              <strong>{t('shift.none')}</strong> {t('shift.noneBody')}
            </p>
          </div>
        </main>
      </div>
    );
  }

  const { shift, sales, people } = data;
  const nameOf = (id: Id | null) => (id === me.id ? t('common.me') : (people.find((p) => p.id === id)?.name ?? ''));
  const shown = sales.filter((s) => inFilter(s, filter));
  const count = (f: SalesFilter) => sales.filter((s) => inFilter(s, f)).length;
  const summary: Record<SalesFilter, { label: MessageKey; amount: number }> = {
    all: { label: 'sales.sumAll', amount: sales.reduce((sum, s) => sum + (s.order.status === 'voided' ? 0 : s.total), 0) },
    pending: { label: 'sales.sumPending', amount: shown.reduce((sum, s) => sum + s.due, 0) },
    paid: { label: 'sales.sumPaid', amount: shown.reduce((sum, s) => sum + s.paid, 0) },
    cancelled: { label: 'sales.sumCancelled', amount: shown.reduce((sum, s) => sum + s.voided_kes, 0) },
  };

  return (
    <div className="c-screen">
      <BackBar to="/counter/sell" title={t('sales.title')} subtitle={t('sales.since', { time: localTime(shift.opened_at) })} />

      <div className="c-orders-summary">
        <span>{t(summary[filter].label, { count: shown.length })}</span>
        <strong>{formatKES(summary[filter].amount)}</strong>
      </div>

      <div className="c-tabs" role="group" aria-label={t('sales.filters')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" className="c-tab" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`sales.filter.${f}` as MessageKey, { count: count(f) })}
          </button>
        ))}
      </div>

      <main className="c-body c-order-list">
        {shown.map((s) => (
          <SaleCard key={s.order.id} sale={s} filter={filter} nameOf={nameOf} />
        ))}
        {shown.length === 0 && (
          <div className="c-empty">
            <strong>{t(sales.length === 0 ? 'sales.empty' : 'sales.emptyFilter')}</strong>
          </div>
        )}
      </main>
    </div>
  );
}

function SaleCard({ sale, filter, nameOf }: { sale: ShiftSale; filter: SalesFilter; nameOf: (id: Id | null) => string }) {
  const { t } = useI18n();
  const { order } = sale;
  const voided = order.status === 'voided';
  const status = voided ? 'voided' : order.status === 'paid' ? 'paid' : sale.paid > 0 ? 'partPaid' : 'pending';
  const amount = voided || filter === 'cancelled'
    ? formatKES(sale.voided_kes)
    : order.status === 'open' && sale.paid > 0
      ? t('orders.left', { amount: formatKES(sale.due) })
      : formatKES(order.status === 'open' ? sale.due : sale.total);
  const v = sale.void;
  const voidText = !v
    ? null
    : v.kind === 'self'
      ? t('sales.void.self')
      : v.status === 'waiting'
        ? t('sales.void.waiting')
        : t(v.status === 'approved' ? 'sales.void.approved' : 'sales.void.rejected', { name: nameOf(v.decided_by) });
  const voidTone = v?.kind === 'approval' ? (v.status === 'waiting' ? 'pending' : v.status === 'approved' ? 'neutral' : 'error') : 'neutral';

  return (
    <Link to={`/counter/orders/${order.id}`} state={{ back: '/counter/shift/sales' }} className="c-order-card c-sale-card">
      <span className="c-order-card-top">
        <strong>
          {displayLabel(order.label, t)}
          {order.note && <span className="c-order-card-note">{order.note}</span>}
        </strong>
        <span className={`c-order-card-amount${voided ? ' is-voided' : ''}`}>{amount}</span>
      </span>
      <span className="c-order-card-bottom">
        <span className="c-order-card-meta">
          {order.short_no} · {localTime(order.created_at)} · {nameOf(order.server_id)} ·{' '}
          {sale.paid > 0 && order.status === 'open'
            ? t('orders.paidOf', { paid: formatKES(sale.paid), total: formatAmount(sale.total) })
            : t('common.items', { count: sale.items })}
        </span>
        <StatusChip status={status} className="k-chip-sm" />
      </span>
      {voidText && <span className={`c-sale-void k-tone-${voidTone}`}>{voidText}</span>}
    </Link>
  );
}
