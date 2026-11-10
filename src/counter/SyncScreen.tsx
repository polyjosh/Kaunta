import { Icon } from '../components/Icon';
import { SYNC } from '../components/SyncPill';
import type { OutboxEntry } from '../data/events';
import { useConnection, useQuery } from '../data/react';
import { useEngineState, useSync, useSyncStatus } from '../sync/SyncProvider';
import { localTime } from '../domain/time';
import type { Id, Order, Person } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import type { TFunction } from '../lib/I18nProvider';
import { formatKES } from '../lib/money';
import { displayLabel } from './labels';
import { BackBar } from './ui';

interface Lookup {
  order: (id: Id) => Order | undefined;
  person: (id: Id) => Person | undefined;
}

/** One queue entry in plain words: what it is, and the money it carries if any. */
export function describeEntry(entry: OutboxEntry, { order, person }: Lookup, t: TFunction): { what: string; amount: number | null } {
  const no = (id: Id) => order(id)?.short_no ?? '';
  const name = (id: Id) => person(id)?.name ?? '';
  switch (entry.type) {
    case 'order_recorded': {
      const { order: o, lines } = entry.payload;
      return {
        what: t('sync.item.order', { no: o.short_no, label: displayLabel(o.label, t) }),
        amount: lines.reduce((sum, l) => sum + l.qty * l.unit_price_kes, 0),
      };
    }
    case 'payment_recorded': {
      const { payments, order_id } = entry.payload;
      const methods = [...new Set(payments.map((p) => t(p.method === 'cash' ? 'pay.cash' : 'pay.mpesa')))].join(' + ');
      return {
        what: t('sync.item.payment', { no: no(order_id), method: methods }),
        amount: payments.reduce((sum, p) => sum + p.amount_kes, 0),
      };
    }
    case 'lines_added':
      return {
        what: t('sync.item.added', { no: no(entry.payload.order_id) }),
        amount: entry.payload.lines.reduce((sum, l) => sum + l.qty * l.unit_price_kes, 0),
      };
    case 'lines_moved':
      return { what: t('sync.item.moved', { no: entry.payload.order.short_no }), amount: null };
    case 'void_recorded':
      return { what: t('sync.item.void', { no: no(entry.payload.order_id) }), amount: null };
    case 'void_requested':
      return { what: t('sync.item.voidRequest', { no: no(entry.payload.order_id) }), amount: entry.payload.approval.amount_kes };
    case 'logged_in':
      return { what: t('sync.item.login', { name: name(entry.payload.person_id) }), amount: null };
    case 'pin_failed':
      return { what: t('sync.item.pinFailed', { name: name(entry.payload.person_id) }), amount: null };
    case 'pin_set':
      return { what: t('login.reset.syncItem', { name: name(entry.payload.person_id) }), amount: null };
    case 'shift_opened':
      return { what: t('sync.item.shiftOpened'), amount: null };
    case 'shift_closed':
      return { what: t('sync.item.shiftClosed'), amount: entry.payload.counted_cash_kes };
    case 'order_handed_over':
      return { what: t('sync.item.handover', { no: no(entry.payload.order_id) }), amount: null };
    case 'handover_accepted':
      return { what: t('sync.item.handoverAccepted'), amount: null };
  }
}

/** Why the server set this aside, in the words of the design (SyncOffline.dc.html). */
export function reviewExplanation(entry: OutboxEntry, t: TFunction): string | null {
  const detail = entry.review_detail ?? {};
  const money = (key: string) => (typeof detail[key] === 'number' ? formatKES(detail[key] as number) : '');
  const product = String(detail.product_name ?? '');
  switch (entry.review_reason) {
    case 'price_mismatch':
      return t('sync.review.priceMismatch', { product, recorded: money('recorded_price_kes'), server: money('server_price_kes') });
    case 'archived_product':
      return t('sync.review.archivedProduct', { product });
    case 'revoked_device':
      return t('sync.review.revokedDevice');
    case null:
    case undefined:
      return null;
    default:
      return t('sync.review.other');
  }
}

/**
 * Screen 7: what is waiting to sync and why that is fine. Rules R-SYNC-1…4.
 * Nothing here is ever red. "Send now" appears when there is a server to send to.
 */
export function SyncScreen() {
  const { t } = useI18n();
  const status = useSyncStatus();
  const { online, since } = useConnection();
  const { engine } = useSync();
  const engineState = useEngineState();

  const data = useQuery(async (d) => {
    const [entries, orders, people, synced, seeded] = await Promise.all([
      d.outbox.where('status').anyOf('pending', 'needs_review').sortBy('seq'),
      d.orders.toArray(),
      d.people.toArray(),
      d.meta.get('last_sync_at'),
      d.meta.get('seeded'),
    ]);
    // The data this phone started with came from the server, so that moment counts as a sync.
    const lastSync = synced ?? seeded;
    return { entries, orders, people, lastSync: typeof lastSync?.value === 'string' ? lastSync.value : null };
  });
  if (!data) return null;

  const lookup: Lookup = {
    order: (id) => data.orders.find((o) => o.id === id),
    person: (id) => data.people.find((p) => p.id === id),
  };
  const waiting = data.entries.filter((e) => e.status === 'pending');
  const review = data.entries.filter((e) => e.status === 'needs_review');
  const lastSynced = data.lastSync ? localTime(data.lastSync) : '–';
  const pill = SYNC[status.state];

  const hero =
    status.state === 'offline'
      ? { head: t('sync.offlineHead'), body: t('sync.offlineBody', { time: localTime(since) }) }
      : status.state === 'needsAdmin'
        ? { head: t('sync.needsAdmin', { count: status.count }), body: t('sync.reviewBody') }
        : waiting.length > 0
          ? { head: t('sync.waitingHead', { count: waiting.length }), body: t('sync.waitingBody', { time: lastSynced }) }
          : { head: t('sync.syncedHead'), body: t('sync.syncedBody', { time: lastSynced }) };

  const meta = (entry: OutboxEntry, amount: number | null) =>
    [amount !== null ? formatKES(amount) : null, localTime(entry.created_at), lookup.person(entry.recorded_by)?.name]
      .filter(Boolean)
      .join(' · ');

  return (
    <div className="c-screen">
      <BackBar to="/counter/sell" title={t('sync.title')} />
      <main className="c-body c-sync">
        <section className={`c-sync-hero k-tone-${pill.tone}`} data-sync={status.state}>
          <Icon name={pill.icon} size={48} strokeWidth={1.8} />
          <strong>{hero.head}</strong>
          <p>{hero.body}</p>
          {engine && online && waiting.length > 0 && (
            <button type="button" className="c-send-now" disabled={engineState.sending > 0} onClick={() => void engine.syncNow()}>
              {t('sync.sendNow')}
            </button>
          )}
        </section>

        {review.map((entry) => {
          const { what } = describeEntry(entry, lookup, t);
          return (
            <section key={entry.id} className="c-review-card">
              <div>
                <strong>{what}</strong>
                <span className="c-time-chip is-old">
                  <Icon name="alert-triangle" size={16} strokeWidth={2.4} />
                  {t('sync.chipNeedsAdmin')}
                </span>
              </div>
              {reviewExplanation(entry, t) && <p>{reviewExplanation(entry, t)}</p>}
              <p>{t('sync.reviewBody')}</p>
            </section>
          );
        })}

        {waiting.length > 0 && (
          <>
            <h2 className="c-section-head">
              {online ? t('sync.listWaiting', { count: waiting.length }) : t('sync.listSaved', { count: waiting.length })}
            </h2>
            {waiting.map((entry) => {
              const { what, amount } = describeEntry(entry, lookup, t);
              return (
                <div key={entry.id} className="c-sync-row">
                  <div>
                    <strong>{what}</strong>
                    <span>{meta(entry, amount)}</span>
                  </div>
                  <span className={`k-chip k-chip-sm k-tone-${online ? 'pending' : 'offline'}`}>
                    <Icon name={online ? 'cloud-up' : 'cloud-off'} size={16} />
                    {online ? t('sync.chipWaiting') : t('sync.chipSaved')}
                  </span>
                </div>
              );
            })}
          </>
        )}

        <p className="c-footnote">{t('sync.footnote')}</p>
      </main>
    </div>
  );
}
