import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { dayLabel } from '../admin/data';
import { Icon } from '../components/Icon';
import { StatusChip } from '../components/StatusChip';
import { useQuery } from '../data/react';
import { openShiftOf } from '../data/shifts';
import { daySales, inFilter, shiftSales } from '../domain/shiftSales';
import type { SalesFilter, ShiftSale } from '../domain/shiftSales';
import { paidFromTill, rejectedExpenses } from '../domain/shifts';
import type { ApprovalStatus, BusinessDay, Id, ShiftExpense } from '../domain/types';
import { businessDayOf, localTime } from '../domain/time';
import { useI18n } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import type { MessageKey } from '../lib/i18n';
import { displayLabel } from './labels';
import { useSession } from './Session';
import { BackBar, useNow } from './ui';

const FILTERS: readonly SalesFilter[] = ['all', 'pending', 'paid', 'cancelled'];

/** The sales filters, and the expenses of the same shift (or day). */
type Tab = SalesFilter | 'expenses';

interface ExpenseRow {
  expense: ShiftExpense;
  status: ApprovalStatus | undefined;
}

const isDay = (v: string | null): v is BusinessDay => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Every sale this person made in their open shift on this phone, newest
 * first: still to collect, paid, and voided (with where an admin's decision
 * on the void stands). Tapping one opens the order. The calendar shows their
 * sales on another business day instead (`?day=`), from what this phone holds.
 */
export function ShiftSalesScreen() {
  const { t, locale } = useI18n();
  const session = useSession();
  const me = session.person;
  const deviceId = session.device?.id;
  const now = useNow();
  const [filter, setFilter] = useState<Tab>('all');
  const [params, setParams] = useSearchParams();
  const dayParam = params.get('day');
  const picked = isDay(dayParam) ? dayParam : null;

  const data = useQuery(
    async (d) => {
      if (!me) return null;
      const [bar, shift, orders] = await Promise.all([
        d.bar.toCollection().first(),
        deviceId ? openShiftOf(d, me.id, deviceId) : undefined,
        d.orders.toArray(),
      ]);
      const ids = orders.map((o) => o.id);
      const [lines, payments, approvals, people, myShifts, expenseApprovals] = await Promise.all([
        d.lines.where('order_id').anyOf(ids).toArray(),
        d.payments.where('order_id').anyOf(ids).toArray(),
        d.approvals.filter((a) => a.kind === 'void' || a.kind === 'write_off').toArray(),
        d.people.toArray(),
        d.shifts.where('person_id').equals(me.id).toArray(),
        d.approvals.filter((a) => a.kind === 'expense').toArray(),
      ]);
      const today = businessDayOf(now, bar?.day_start);
      // A day picked: that day's sales. No open shift: today's.
      const day = picked ?? (shift ? null : today);
      // Expenses: this shift's, or those of my shifts that started on that day (any phone).
      const expenseShifts = day ? myShifts.filter((s) => businessDayOf(s.opened_at, bar?.day_start) === day) : shift ? [shift] : [];
      const status = new Map(expenseApprovals.map((a) => [a.target.expense_id, a.status]));
      const expenses: ExpenseRow[] = expenseShifts
        .flatMap((s) => s.expenses)
        .map((expense) => ({ expense, status: expense.id ? status.get(expense.id) : undefined }))
        .sort((a, b) => (b.expense.at ?? '').localeCompare(a.expense.at ?? ''));
      const rejected = rejectedExpenses(expenseApprovals);
      return {
        shift: shift ?? null,
        day,
        today,
        // The oldest day this phone holds.
        first: orders.reduce((min, o) => (o.business_day < min ? o.business_day : min), today),
        sales: day || !shift ? daySales(day ?? today, me.id, orders, lines, payments, approvals) : shiftSales(shift, me.id, orders, lines, payments, approvals),
        people,
        expenses,
        // Rejected expenses do not count, as at shift close.
        expensesKes: expenses.reduce((sum, e) => (e.expense.id && rejected.has(e.expense.id) ? sum : sum + e.expense.amount_kes), 0),
      };
    },
    [me?.id, deviceId, picked, Math.floor(now.getTime() / 60_000)],
  );
  if (!me || !data) return null;

  const { shift, day, today, first, sales, people, expenses, expensesKes } = data;
  const pick = (next: BusinessDay | null) => {
    setFilter('all');
    setParams(next ? { day: next } : {}, { replace: true });
  };
  const back = picked ? `/counter/shift/sales?day=${picked}` : '/counter/shift/sales';
  const nameOf = (id: Id | null) => (id === me.id ? t('common.me') : (people.find((p) => p.id === id)?.name ?? ''));
  const onExpenses = filter === 'expenses';
  const salesFilter: SalesFilter = onExpenses ? 'all' : filter;
  const shown = sales.filter((s) => inFilter(s, salesFilter));
  const count = (f: SalesFilter) => sales.filter((s) => inFilter(s, f)).length;
  const summary: Record<SalesFilter, { label: MessageKey; amount: number }> = {
    all: { label: 'sales.sumAll', amount: sales.reduce((sum, s) => sum + (s.order.status === 'voided' ? 0 : s.total), 0) },
    pending: { label: 'sales.sumPending', amount: shown.reduce((sum, s) => sum + s.due, 0) },
    paid: { label: 'sales.sumPaid', amount: shown.reduce((sum, s) => sum + s.paid, 0) },
    cancelled: { label: 'sales.sumCancelled', amount: shown.reduce((sum, s) => sum + s.voided_kes, 0) },
  };

  return (
    <div className="c-screen">
      <BackBar
        to="/counter/sell"
        title={day ? t('sales.dayTitle') : t('sales.title')}
        subtitle={day ? dayLabel(day, locale) : shift ? t('sales.since', { time: localTime(shift.opened_at) }) : undefined}
      />

      <div className="c-sales-day">
        <SalesDayPicker day={day ?? today} first={first} today={today} onPick={pick} />
        {day && shift && (
          <button type="button" className="c-btn c-btn-link c-sales-back" onClick={() => pick(null)}>
            {t('sales.backToShift')}
          </button>
        )}
      </div>

      <div className="c-orders-summary">
        <span>{t(summary[salesFilter].label, { count: shown.length })}</span>
        <strong>{formatKES(summary[salesFilter].amount)}</strong>
      </div>
      <div className="c-orders-summary c-expenses-summary">
        <span>{t('sales.expensesTotal', { count: expenses.length })}</span>
        <strong>{formatKES(expensesKes)}</strong>
      </div>

      <div className="c-tabs" role="group" aria-label={t('sales.filters')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" className="c-tab" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`sales.filter.${f}` as MessageKey, { count: count(f) })}
          </button>
        ))}
        <button type="button" className="c-tab" aria-pressed={onExpenses} onClick={() => setFilter('expenses')}>
          {t('sales.filter.expenses', { count: expenses.length })}
        </button>
      </div>

      {onExpenses ? (
        <main className="c-body c-order-list">
          <ul className="c-expense-list">
            {expenses.map(({ expense: e, status }, i) => (
              <li key={e.id ?? i} className={`c-expense-row c-sale-expense${status === 'rejected' ? ' is-rejected' : ''}`}>
                <div className="c-expense-text">
                  <strong>{e.label}</strong>
                  <span>
                    {t(paidFromTill(e) ? 'expense.fromTill' : 'expense.fromCash')}
                    {e.at ? ` · ${localTime(e.at)}` : ''}
                  </span>
                  {(status === 'waiting' || status === 'approved' || status === 'rejected') && (
                    <span className={`c-expense-status is-${status}`}>{t(`expense.status.${status}`)}</span>
                  )}
                </div>
                <strong className="c-expense-amount">{formatKES(e.amount_kes)}</strong>
              </li>
            ))}
          </ul>
          {expenses.length === 0 && (
            <div className="c-empty">
              <strong>{t('sales.noExpenses')}</strong>
            </div>
          )}
          {!day && shift && (
            <Link className="c-btn c-btn-secondary c-sales-manage" to="/counter/shift/expenses">
              {t('sales.manageExpenses')}
            </Link>
          )}
        </main>
      ) : (
      <main className="c-body c-order-list">
        {shown.map((s) => (
          <SaleCard key={s.order.id} sale={s} filter={salesFilter} nameOf={nameOf} back={back} />
        ))}
        {shown.length === 0 && (
          <div className="c-empty">
            <strong>{t(sales.length === 0 ? (day ? 'sales.emptyDay' : 'sales.empty') : 'sales.emptyFilter')}</strong>
          </div>
        )}
      </main>
      )}
    </div>
  );
}

function SaleCard({ sale, filter, nameOf, back }: { sale: ShiftSale; filter: SalesFilter; nameOf: (id: Id | null) => string; back: string }) {
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
    <Link to={`/counter/orders/${order.id}`} state={{ back }} className="c-order-card c-sale-card">
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

/** The calendar: a button showing the day, opening the phone's date picker (days this phone holds, up to today). */
function SalesDayPicker({ day, first, today, onPick }: { day: BusinessDay; first: BusinessDay; today: BusinessDay; onPick: (day: BusinessDay) => void }) {
  const { t, locale } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const open = () => {
    const el = input.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      // Older browsers: the field itself takes the date.
      el.focus();
      el.click();
    }
  };
  return (
    <span className="c-daypick">
      <button type="button" className="c-chip-btn c-daypick-btn" onClick={open} aria-label={t('sales.pickDay', { date: dayLabel(day, locale) })}>
        <Icon name="calendar" size={20} />
        <span>{dayLabel(day, locale)}</span>
      </button>
      {/* Over the button: on phones the tap lands on the field itself (scripts may not open it there). */}
      <input
        ref={input}
        className="c-daypick-input"
        type="date"
        tabIndex={-1}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker();
          } catch {
            // The browser opens it by itself.
          }
        }}
        aria-label={t('sales.pickDayField')}
        min={first}
        max={today}
        value={day}
        onChange={(e) => {
          const v = e.target.value;
          if (isDay(v) && v >= first && v <= today) onPick(v);
        }}
      />
    </span>
  );
}
