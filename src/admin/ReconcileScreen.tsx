import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { StatusChip } from '../components/StatusChip';
import { displayLabel } from '../counter/labels';
import { recordAdminEvent } from '../data/adminEvents';
import { useDb } from '../data/react';
import { canCloseDay, mpesaRecon, mpesaVariance, shiftRecon, tillPaidOut } from '../domain/admin';
import { paidFromTill, rejectedExpenses } from '../domain/shifts';
import { businessDayOf } from '../domain/time';
import type { BusinessDay } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import { AdminLayout, PageTitle } from './AdminLayout';
import { useAdmin, useNow } from './AdminSession';
import { dayLabel, deviceName, hhmm, personName, shiftDay, useDayData } from './data';

/** Whole KES typed by the admin: digits only, no decimals. */
export function parseKes(text: string): number | null {
  const digits = text.replace(/[^0-9]/g, '');
  return digits === '' ? null : Number(digits);
}

/** Reconciliation (Recon.dc.html): cash per shift (R-SHIFT-2) and M-Pesa against the till (R-DAY-3). */
export function ReconcileScreen({ day }: { day: BusinessDay }) {
  const { t, locale } = useI18n();
  const db = useDb();
  const { ctx, now } = useAdmin();
  const clock = useNow();
  const data = useDayData(day);
  const [tillText, setTillText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!data) return <AdminLayout>{null}</AdminLayout>;
  const shifts = shiftRecon(data, day);
  const rejected = rejectedExpenses(data.approvals);
  const mpesa = mpesaRecon(data);
  const closed = data.dayClose;
  const till = closed ? closed.till_total_kes : parseKes(tillText ?? '');
  const paidOut = tillPaidOut(shifts);
  const variance = till === null ? null : mpesaVariance(mpesa.recorded_kes, till, paidOut);
  const openShifts = shifts.filter((s) => s.shift.closed_at === null).length;
  const today = businessDayOf(clock, data.bar.day_start);
  const orderOf = (id: string) => data.orders.find((o) => o.id === id);

  const close = async () => {
    if (till === null) return;
    setError(null);
    try {
      await recordAdminEvent(db, ctx, {
        type: 'day_closed',
        payload: { day_close: { business_day: day, till_total_kes: till, recorded_mpesa_kes: mpesa.recorded_kes, closed_by: ctx.person_id, closed_at: now().toISOString() } },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const shortNotes = shifts.filter((s) => s.result?.kind === 'short').map((s) => t('admin.recon.shortNote', { name: personName(data.people, s.shift.person_id), amount: formatKES(s.result!.amount_kes) }));
  const openNotes = shifts.filter((s) => !s.result).map((s) => t('admin.recon.openNote', { name: personName(data.people, s.shift.person_id), device: deviceName(data.devices, s.shift.device_id) ?? '' }));

  return (
    <AdminLayout>
      <PageTitle
        title={t('recon.title', { date: dayLabel(day, locale) })}
        aside={
          <>
            {t('admin.recon.subtitle')}
            {openShifts > 0 && ` · ${t('admin.recon.shiftsOpen', { count: openShifts })}`}
          </>
        }
      />
      <nav className="a-daynav" aria-label={t('admin.recon.otherDays')}>
        <Link className="a-link" to={`/admin/reconcile/${shiftDay(day, -1)}`}>← {dayLabel(shiftDay(day, -1), locale)}</Link>
        {day < today && <Link className="a-link" to={`/admin/reconcile/${shiftDay(day, 1)}`}>{dayLabel(shiftDay(day, 1), locale)} →</Link>}
      </nav>

      <section className="a-card" aria-labelledby="recon-cash">
        <div className="a-card-head">
          <h2 id="recon-cash" className="a-h2-lg">{t('recon.cashPerShift')}</h2>
          <span className="a-note">{t('recon.formula')}</span>
        </div>
        {shifts.length === 0 ? (
          <p className="a-muted">{t('admin.recon.noShifts')}</p>
        ) : (
          <div className="a-table-wrap">
            <table className="a-table a-table-wide">
              <thead>
                <tr>
                  <th scope="col">{t('admin.recon.shift')}</th>
                  <th scope="col">{t('admin.recon.float')}</th>
                  <th scope="col">{t('admin.recon.cashSales')}</th>
                  <th scope="col">{t('admin.recon.expenses')}</th>
                  <th scope="col">{t('admin.recon.expected')}</th>
                  <th scope="col">{t('admin.recon.counted')}</th>
                  <th scope="col" className="is-left">{t('admin.recon.result')}</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((r) => (
                  <tr key={r.shift.id}>
                    <th scope="row">
                      {personName(data.people, r.shift.person_id)}
                      <div className="a-sub">
                        {deviceName(data.devices, r.shift.device_id)} · {hhmm(r.shift.opened_at)} – {r.shift.closed_at ? hhmm(r.shift.closed_at) : t('admin.recon.stillOpen')}
                      </div>
                    </th>
                    <td>{formatAmount(r.shift.float_kes)}</td>
                    <td>{formatAmount(r.cash_sales_kes)}</td>
                    <td>
                      {formatAmount(r.expenses_kes)}
                      <div className="a-sub">
                        {r.shift.expenses.map((e) => `${e.label} ${formatAmount(e.amount_kes)}${paidFromTill(e) ? ` (${t('expense.fromTill')})` : ''}${e.id && rejected.has(e.id) ? ` (${t('admin.decided.rejected')})` : ''}`).join(' · ')}
                        {!r.result && r.shift.expenses.length === 0 && t('admin.recon.soFar')}
                      </div>
                    </td>
                    <td className="is-strong">{formatAmount(r.expected_kes)}</td>
                    <td className="is-strong">{r.shift.counted_cash_kes !== null && r.result ? formatAmount(r.shift.counted_cash_kes) : '—'}</td>
                    <td className="is-left">
                      {r.result === null ? (
                        <StatusChip status="pending" className="a-chip-sm">{t('recon.shiftOpen')}</StatusChip>
                      ) : r.result.kind === 'matches' ? (
                        <StatusChip status="matches" className="a-chip-sm" />
                      ) : (
                        <StatusChip status={r.result.kind} className="a-chip-sm">
                          {t(r.result.kind === 'short' ? 'admin.shortAmount' : 'admin.overAmount', { amount: formatKES(r.result.amount_kes) })}
                        </StatusChip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="a-note">{[t('admin.recon.amountsInKes'), ...shortNotes, ...openNotes].join(' ')}</p>
      </section>

      <section className="a-card" aria-labelledby="recon-mpesa">
        <div className="a-card-head">
          <h2 id="recon-mpesa" className="a-h2-lg">{t('recon.mpesaDay')}</h2>
          <span className="a-note">{t('admin.recon.compare')}</span>
        </div>
        <div className="a-tiles">
          <div className="a-tile">
            <span className="a-tile-label">{t('recon.recorded')}</span>
            <span className="a-tile-money">{formatKES(mpesa.recorded_kes)}</span>
            <span className="a-note">{t('admin.recon.payments', { count: mpesa.payments, coded: mpesa.with_code })}</span>
            {paidOut > 0 && <span className="a-note is-strong">{t('admin.recon.tillPaidOut', { amount: formatKES(paidOut), expected: formatKES(mpesa.recorded_kes - paidOut) })}</span>}
          </div>
          <label className="a-tile a-tile-input">
            <span className="a-tile-label is-strong">{t('recon.till')}</span>
            <span className="a-kes-input">
              <span>KES</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={closed ? formatAmount(closed.till_total_kes) : tillText ?? ''}
                readOnly={!!closed}
                placeholder="0"
                onChange={(e) => {
                  const n = parseKes(e.target.value);
                  setTillText(n === null ? '' : formatAmount(n));
                }}
                aria-label={t('admin.recon.tillAria')}
              />
            </span>
            <span className="a-note">{t('admin.recon.tillHint')}</span>
          </label>
          <div className={`a-tile a-variance ${variance === null ? 'is-empty' : variance.kind === 'matches' ? 'k-tone-paid' : 'k-tone-error'}`} aria-live="polite">
            {variance === null ? (
              <span className="a-note">{t('admin.recon.enterTill')}</span>
            ) : (
              <>
                <span className="a-tile-label is-strong">
                  {variance.kind === 'matches' ? t('status.matches') : variance.kind === 'notOnTill' ? t('recon.notOnTill') : t('recon.notRecorded')}
                </span>
                <span className="a-tile-money">{formatKES(variance.amount_kes)}</span>
                <span>{t(`admin.recon.variance.${variance.kind}`)}</span>
              </>
            )}
          </div>
        </div>

        {variance?.kind === 'notOnTill' && mpesa.without_code.length > 0 && (
          <div className="a-check">
            <h3>{t('recon.checkFirst')}</h3>
            {mpesa.without_code.map((p) => {
              const order = orderOf(p.order_id);
              const split = data.payments.some((x) => x.order_id === p.order_id && x.id !== p.id && x.created_at === p.created_at);
              return (
                <div key={p.id} className="a-check-row">
                  <span>
                    <b>{order ? `${order.short_no} ${displayLabel(order.label, t)}` : p.order_id}</b> · {split ? t('admin.recon.mpesaPart') : 'M-Pesa'} ·{' '}
                    {personName(data.people, p.recorded_by)} · {hhmm(p.created_at)}
                  </span>
                  <strong>{formatKES(p.amount_kes)}</strong>
                  <Link className="a-btn a-btn-sm" to={`/admin/audit?q=${encodeURIComponent(order?.short_no ?? '')}&day=${day}`}>
                    {t('admin.recon.openOrder')}
                  </Link>
                </div>
              );
            })}
          </div>
        )}

        {error && <p className="a-error" role="alert">{error}</p>}
        <div className="a-close-row">
          {closed ? (
            <span className="a-decided is-yes">
              <Icon name="check" size={18} strokeWidth={2.4} />
              {t('admin.recon.closedBy', { name: personName(data.people, closed.closed_by), time: hhmm(closed.closed_at) })}
            </span>
          ) : (
            <>
              <button type="button" className="a-btn a-btn-primary a-btn-lg" disabled={!canCloseDay(shifts, till)} onClick={close}>
                {t('recon.closeDay')}
              </button>
              <span className="a-note">{t('admin.recon.closeHint')}</span>
            </>
          )}
        </div>
      </section>
    </AdminLayout>
  );
}
