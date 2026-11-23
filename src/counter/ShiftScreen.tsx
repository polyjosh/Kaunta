import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { STATUS } from '../components/StatusChip';
import { useDb, useQuery } from '../data/react';
import { closeShift, handOverOrder, shiftSummary } from '../data/shifts';
import { orderDue, orderTotal, paidTotal } from '../domain/orders';
import { expensesTotal, shiftResult, tillExpensesTotal } from '../domain/shifts';
import { localTime, minutesBetween } from '../domain/time';
import { useI18n } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import { displayLabel } from './labels';
import { useSession } from './Session';
import { signsInAtCounter } from '../data/login';
import type { Id } from '../domain/types';
import { Avatar, BackBar, NumberPad, Sheet, useNow } from './ui';

/** Screen 6: settle open orders, then count the cash. Rules R-SHIFT-1, R-SHIFT-2, R-ORD-6. */
export function ShiftScreen() {
  const { t } = useI18n();
  const db = useDb();
  const session = useSession();
  const navigate = useNavigate();
  const now = useNow();
  const [counted, setCounted] = useState(0);
  const [touched, setTouched] = useState(false);
  /** The order being handed over: pick who takes it. */
  const [handing, setHanding] = useState<Id | null>(null);
  const busy = useRef(false);

  const me = session.person;
  const deviceId = session.device?.id;
  const data = useQuery(
    async (d) => {
      if (!me || !deviceId) return null;
      const summary = await shiftSummary(d, me.id, deviceId);
      if (!summary) return null;
      const ids = summary.blocking.map((o) => o.id);
      const [lines, payments, people] = await Promise.all([
        d.lines.where('order_id').anyOf(ids).toArray(),
        d.payments.where('order_id').anyOf(ids).toArray(),
        d.people.toArray(),
      ]);
      return { summary, lines, payments, people };
    },
    [me?.id, deviceId],
  );
  if (!me || data === undefined) return null;
  if (data === null) {
    // No open shift for this person on this phone (closed elsewhere, or none was started): say so.
    return (
      <div className="c-screen">
        <BackBar to="/counter/sell" title={t('shift.title')} />
        <main className="c-body c-locked">
          <div className="c-locked-card">
            <p className="c-locked-body">
              <strong>{t('shift.none')}</strong> {t('shift.noneBody')}
            </p>
          </div>
          <div className="c-locked-actions">
            <button
              type="button"
              className="c-btn c-btn-primary"
              onClick={() => {
                session.logout();
                navigate('/counter/login', { replace: true });
              }}
            >
              {t('sell.switchUser')}
            </button>
          </div>
        </main>
      </div>
    );
  }

  const { summary } = data;
  const { shift, blocking } = summary;
  const subtitle = `${me.name} · ${session.device?.name ?? ''} · ${localTime(shift.opened_at)} – ${localTime(now)}`;

  if (blocking.length > 0) {
    return (
      <div className="c-screen">
        <BackBar to="/counter/sell" title={t('shift.title')} subtitle={subtitle} />
        <main className="c-body c-shift">
          <div className="c-banner k-tone-warning">
            <Icon name="alert-triangle" size={26} />
            <div>
              <strong>{t('shift.blockedHead', { count: blocking.length })}</strong>
              <p>{t('shift.blockedBody')}</p>
            </div>
          </div>

          {blocking.map((order) => {
            const lines = data.lines.filter((l) => l.order_id === order.id);
            const payments = data.payments.filter((p) => p.order_id === order.id);
            const paid = paidTotal(payments);
            const due = orderDue(lines, payments);
            const server = data.people.find((p) => p.id === order.server_id)?.name ?? '';
            const items = lines.reduce((sum, l) => (l.status === 'voided' ? sum : sum + l.qty), 0);
            return (
              <article key={order.id} className="c-settle-card">
                <div className="c-settle-top">
                  <strong>
                    {displayLabel(order.label, t)} <span className="c-order-no">{order.short_no}</span>
                  </strong>
                  <span>{paid > 0 ? t('orders.left', { amount: formatKES(due) }) : formatKES(due)}</span>
                </div>
                <p>
                  {server} ·{' '}
                  {paid > 0
                    ? t('orders.paidOf', { paid: formatKES(paid), total: formatAmount(orderTotal(lines)) })
                    : `${t('common.items', { count: items })} · ${t('common.minutes', { count: minutesBetween(order.created_at, now) })}`}
                </p>
                <div className="c-settle-actions">
                  <button type="button" className="c-settle-pay" onClick={() => navigate(`/counter/orders/${order.id}`)}>
                    {t('shift.pay')}
                  </button>
                  <button type="button" className="c-settle-void" onClick={() => navigate(`/counter/orders/${order.id}/void`)}>
                    {t('shift.void')}
                  </button>
                  <button
                    type="button"
                    className="c-settle-hand"
                    onClick={() => setHanding(order.id)}
                  >
                    {t('shift.handOver')}
                  </button>
                </div>
              </article>
            );
          })}
          <p className="c-footnote">{t('shift.handOverToNote')}</p>
        </main>
        {handing && (
          <Sheet title={t('shift.handOverTo')} subtitle={t('shift.handOverToHint')} onClose={() => setHanding(null)}>
            <div className="c-rows">
              {data.people
                .filter((p) => p.id !== me.id && signsInAtCounter(p))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="c-row c-server-row"
                    onClick={() => {
                      const id = handing;
                      setHanding(null);
                      void handOverOrder(db, session.recordContext(), id, p.id);
                    }}
                  >
                    <Avatar person={p} size={40} />
                    <span>{p.name}</span>
                  </button>
                ))}
            </div>
          </Sheet>
        )}
        <footer className="c-bottom">
          <button type="button" className="c-btn c-btn-blocked" disabled>
            {t('shift.countBlocked', { count: blocking.length })}
          </button>
        </footer>
      </div>
    );
  }

  const expected = summary.expected_cash_kes;
  const result = shiftResult(counted, expected);
  const chip = STATUS[result.kind];

  const close = async () => {
    if (!touched || busy.current) return;
    busy.current = true;
    try {
      await closeShift(db, session.recordContext(), counted);
      // Closing the shift logs out.
      session.logout();
      navigate('/counter/login', { replace: true });
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="c-screen">
      <BackBar to="/counter/sell" title={t('shift.title')} subtitle={subtitle} />
      <main className="c-body c-shift">
        <dl className="c-breakdown">
          <div>
            <dt>{t('shift.float')}</dt>
            <dd>{formatKES(shift.float_kes)}</dd>
          </div>
          <div>
            <dt>{t('shift.cashSales')}</dt>
            <dd>{formatKES(summary.cash_sales_kes)}</dd>
          </div>
          <div>
            <dt>
              {t('shift.expenses')}{' '}
              <Link className="c-inline-link" to="/counter/shift/expenses">
                {t('expense.addShort')}
              </Link>
            </dt>
            <dd>{formatKES(expensesTotal(shift, summary.rejected))}</dd>
          </div>
          <div className="c-breakdown-total">
            <dt>{t('shift.expected')}</dt>
            <dd>{formatKES(expected)}</dd>
          </div>
        </dl>

        <div className="c-field">
          <span className="c-field-label" id="shift-counted">
            {t('shift.counted')}
          </span>
          <div className="c-amount-display" aria-live="polite" aria-labelledby="shift-counted">
            <span>KES</span>
            <strong>{formatAmount(counted)}</strong>
          </div>
        </div>

        {/* Updates on every key press. Short is written in words, never as a minus. */}
        <div className={`c-result k-tone-${chip.tone}`} data-result={result.kind}>
          <span>
            <Icon name={chip.icon} size={22} />
            {t(chip.label)}
          </span>
          <strong>{formatKES(result.amount_kes)}</strong>
        </div>

        <NumberPad
          value={counted}
          onChange={(value) => {
            setCounted(value);
            setTouched(true);
          }}
        />
      </main>
      <footer className="c-bottom c-bottom-stack">
        <button type="button" className="c-btn c-btn-primary" disabled={!touched} onClick={() => void close()}>
          {t('shift.closeButton')}
        </button>
        <p className="c-footnote c-center">
          {t('shift.mpesaNote', { amount: formatKES(summary.mpesa_kes) })}
          {tillExpensesTotal(shift, summary.rejected) > 0 && ` · ${t('shift.tillExpenses', { amount: formatKES(tillExpensesTotal(shift, summary.rejected)) })}`}
        </p>
      </footer>
    </div>
  );
}
