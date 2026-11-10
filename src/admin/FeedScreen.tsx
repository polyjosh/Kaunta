import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusChip } from '../components/StatusChip';
import type { Status } from '../components/StatusChip';
import { displayLabel, productName, sizeLabel } from '../counter/labels';
import { useQuery } from '../data/react';
import { byServer, feedRows, todaySummary } from '../domain/admin';
import type { FeedKind, FeedRow } from '../domain/admin';
import { businessDayOf } from '../domain/time';
import type { OrderLine } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import type { TFunction } from '../lib/I18nProvider';
import type { Locale, MessageKey } from '../lib/i18n';
import { formatAmount, formatKES } from '../lib/money';
import { AdminLayout, PageTitle } from './AdminLayout';
import { useNow } from './AdminSession';
import { approvalCard } from './ApprovalsScreen';
import { deviceName, hhmm, personName, useDayData } from './data';
import type { AdminDay } from './data';

const SHOW = 40;
type Filter = 'all' | FeedKind;
const FILTERS: [Filter, MessageKey][] = [
  ['all', 'feed.everything'],
  ['served', 'feed.served'],
  ['paid', 'status.paid'],
  ['void', 'feed.voids'],
  ['review', 'status.needsReview'],
];
const CHIP: Record<FeedKind, Status> = { served: 'pending', paid: 'paid', void: 'voided', review: 'needsReview' };

function linesText(lines: readonly OrderLine[], data: AdminDay, t: TFunction, locale: Locale, withSize = false): string {
  if (lines.length > 2) return t('common.items', { count: lines.reduce((s, l) => s + l.qty, 0) });
  return lines
    .map((l) => {
      const product = data.products.find((p) => p.id === l.product_id);
      const size = data.sizes.find((s) => s.id === l.size_id);
      return `${product ? productName(product, locale) : l.product_id}${withSize && size ? ` ${sizeLabel(size, locale)}` : ''} ×${l.qty}`;
    })
    .join(', ');
}

function describe(row: FeedRow, data: AdminDay, t: TFunction, locale: Locale): { what: string; who: string } {
  const order = row.order;
  const head = order ? `${order.short_no} ${displayLabel(order.label, t)}` : '';
  const device = deviceName(data.devices, row.kind === 'paid' ? row.payments[0]?.device_id ?? row.device_id : row.device_id);
  const by = (who: string) => [order ? t('admin.feed.server', { name: personName(data.people, order.server_id) }) : null, t('admin.feed.recordedBy', { name: who }), device].filter(Boolean).join(' · ');
  switch (row.kind) {
    case 'paid': {
      const methods = row.payments.map((p) =>
        p.method === 'cash'
          ? row.payments.length > 1 ? `${t('pay.cash')} ${formatAmount(p.amount_kes)}` : t('pay.cash')
          : `M-Pesa${row.payments.length > 1 ? ` ${formatAmount(p.amount_kes)}` : ''}${p.mpesa_ref_last4 ? ` …${p.mpesa_ref_last4}` : ''}`,
      );
      return { what: `${head} · ${methods.join(' + ')}`, who: by(personName(data.people, row.payments[0]?.recorded_by ?? row.actor_id)) };
    }
    case 'served':
      return { what: `${head} · ${linesText(row.lines, data, t, locale)}`, who: by(personName(data.people, row.actor_id)) };
    case 'void':
      return {
        what: `${order?.short_no ?? ''} ${linesText(row.lines, data, t, locale, true)} · ${t('admin.feed.selfVoid', { reason: t(`void.reason.${row.selfVoid?.reason ?? 'mistake'}` as MessageKey).toLowerCase() })}`,
        who: [personName(data.people, row.actor_id), t('admin.feed.withinWindow', { minutes: data.bar.self_void_minutes })].join(' · '),
      };
    case 'review': {
      const a = row.approval!;
      if (a.kind === 'price_mismatch') {
        const card = approvalCard(a, data, t, locale);
        return { what: t('admin.feed.priceMismatch', { no: order?.short_no ?? '' }), who: `${card.facts[1]?.[1] ?? ''}${device ? ` · ${device}` : ''}` };
      }
      const what = a.kind === 'void' ? 'admin.feed.voidRequested' : a.kind === 'comp' ? 'admin.feed.compRequested' : a.kind === 'write_off' ? 'admin.feed.writeOffReported' : 'admin.feed.flagged';
      const items = a.target.whole_order ? t('admin.wholeOrder') : linesText(row.lines.length ? row.lines : [], data, t, locale) || card(a, data, t, locale);
      return {
        what: `${t(what as MessageKey)} · ${[order?.short_no, items].filter(Boolean).join(' ')}`,
        who: [t('admin.feed.askedBy', { name: personName(data.people, a.requested_by) }), device].filter(Boolean).join(' · '),
      };
    }
  }
}

function card(a: NonNullable<FeedRow['approval']>, data: AdminDay, t: TFunction, locale: Locale): string {
  return approvalCard(a, data, t, locale).title;
}

/** Live sales feed (Feed.dc.html). New rows appear as counters sync. */
export function FeedScreen() {
  const { t, locale } = useI18n();
  const now = useNow();
  const day = businessDayOf(now);
  const data = useDayData(day);
  const audit = useQuery((db) => db.auditEvents.where('at').aboveOrEqual(new Date(Date.parse(`${day}T00:00:00.000Z`)).toISOString()).toArray(), [day]);
  const [filter, setFilter] = useState<Filter>('all');

  if (!data || !audit) return <AdminLayout>{null}</AdminLayout>;
  const all = feedRows(audit.filter((e) => businessDayOf(e.at, data.bar.day_start) === day), data);
  const rows = all.filter((r) => filter === 'all' || r.kind === filter);
  const count = (f: Filter) => (f === 'all' ? all.length : all.filter((r) => r.kind === f).length);
  const servers = byServer(data);
  const total = todaySummary(data);

  return (
    <AdminLayout>
      <PageTitle title={t('feed.title')} aside={<span className="k-chip k-tone-paid a-live"><span className="a-live-dot" />{t('feed.live')}</span>} />
      <div className="a-chips" role="group" aria-label={t('admin.feed.filter')}>
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" className="a-filter" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {t(label)} <span className="a-filter-count">{count(id)}</span>
          </button>
        ))}
      </div>
      <div className="a-row is-top">
        <section className="a-card a-feed" aria-label={t('feed.title')} aria-live="polite">
          {rows.length === 0 && <p className="a-muted a-feed-empty">{t('admin.feed.empty')}</p>}
          {rows.slice(0, SHOW).map((r) => {
            const d = describe(r, data, t, locale);
            return (
              <div key={r.id} className="a-feed-row">
                <span className="a-feed-time">{hhmm(r.at)}</span>
                <StatusChip status={CHIP[r.kind]} className="a-chip-sm">
                  {r.kind === 'served' ? t('feed.servedPending') : undefined}
                </StatusChip>
                <span className="a-feed-what">
                  <strong>{d.what}</strong>
                  <span>{d.who}</span>
                </span>
                <span className="a-money a-feed-amount">{formatKES(r.amount_kes)}</span>
              </div>
            );
          })}
          <p className="a-feed-foot">
            {t('admin.feed.showing', { count: Math.min(SHOW, rows.length) })} · <Link to="/admin/audit">{t('admin.feed.fullHistory')}</Link>
          </p>
        </section>

        <section className="a-card a-feed-side" aria-labelledby="feed-servers">
          <h2 id="feed-servers">{t('feed.byServer')}</h2>
          <div className="a-table-wrap">
            <table className="a-table a-table-servers">
              <thead>
                <tr>
                  <th scope="col">{t('common.server')}</th>
                  <th scope="col">{t('feed.served')}</th>
                  <th scope="col">{t('admin.feed.collected')}</th>
                  <th scope="col">{t('feed.notPaid')}</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.person_id}>
                    <th scope="row">
                      {personName(data.people, s.person_id)}
                      <div className="a-sub">{t('admin.feed.orders', { count: s.orders })}</div>
                    </th>
                    <td className="is-strong">{formatAmount(s.served_kes)}</td>
                    <td>{formatAmount(s.collected_kes)}</td>
                    <td className={s.not_paid_kes ? 'is-strong a-warn-text' : 'a-sub'}>{s.not_paid_kes ? formatAmount(s.not_paid_kes) : '—'}</td>
                  </tr>
                ))}
                <tr className="is-total">
                  <th scope="row">{t('common.total')}</th>
                  <td>{formatAmount(total.served_kes)}</td>
                  <td>{formatAmount(total.collected_kes)}</td>
                  <td className="a-warn-text">{formatAmount(total.money_at_risk_kes)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="a-note">{t('admin.feed.serversNote')}</p>
        </section>
      </div>
    </AdminLayout>
  );
}
