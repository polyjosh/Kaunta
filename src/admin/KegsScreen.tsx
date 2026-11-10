import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { StatusChip } from '../components/StatusChip';
import { productName } from '../counter/labels';
import { recordAdminEvent } from '../data/adminEvents';
import { useDb, useQuery } from '../data/react';
import { kegSummary } from '../domain/admin';
import { nextQueuedKeg } from '../domain/kegs';
import { businessDayOf } from '../domain/time';
import type { Keg } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import type { TFunction } from '../lib/I18nProvider';
import type { Locale } from '../lib/i18n';
import { formatKES } from '../lib/money';
import { AdminLayout, PageTitle } from './AdminLayout';
import { useAdmin, useNow } from './AdminSession';
import { dayLabel, hhmm, personName, useDayData } from './data';
import type { AdminDay } from './data';

const litres = (ml: number) => String(Math.round(ml / 100) / 10);

/** "today 23:08", "Mon 9 Nov 18:20". */
function when(instant: string, today: string, dayStart: string, t: TFunction, locale: Locale): string {
  const day = businessDayOf(instant, dayStart);
  return day === today ? t('admin.kegs.today', { time: hhmm(instant) }) : `${dayLabel(day, locale)} ${hhmm(instant)}`;
}

function KegSummaryCard({ keg, data, today }: { keg: Keg; data: AdminDay; today: string }) {
  const { t, locale } = useI18n();
  const db = useDb();
  const { ctx } = useAdmin();
  const sales = { ...data, ...(data.kegSales ?? {}) };
  const s = kegSummary(keg, sales);
  const product = data.products.find((p) => p.id === keg.product_id);
  const name = `${product ? productName(product, locale) : ''} #${keg.code}`;
  const mugs = s.by_server.reduce((n, r) => n + r.mugs, 0);
  const jugs = s.by_server.reduce((n, r) => n + r.jugs, 0);
  const jugSize = data.sizes.find((x) => x.product_id === keg.product_id && x.deduct !== keg.cup_ml);
  const finishEvent = keg.finished_by ? personName(data.people, keg.finished_by) : '';
  const check = (cups: number) =>
    recordAdminEvent(db, ctx, { type: 'keg_checked', payload: { keg_id: keg.id, write_off_cups: cups, value_kes: cups * s.mug_price_kes } });

  return (
    <section className={`a-card a-keg-summary${s.short_cups > 0 && !keg.checked_at ? ' is-short' : ''}`} aria-labelledby={`keg-${keg.id}`}>
      <div className="a-card-head">
        <div className="a-title-stack">
          <span className="a-eyebrow">{t('kegs.summary')}</span>
          <h2 id={`keg-${keg.id}`}>{name}</h2>
          <span className="a-note">
            {[
              keg.tapped_at && t('admin.kegs.tapped', { when: when(keg.tapped_at, today, data.bar.day_start, t, locale) }),
              keg.finished_at && t('admin.kegs.finishedAt', { when: when(keg.finished_at, today, data.bar.day_start, t, locale) }),
              finishEvent && t('admin.kegs.markedBy', { name: finishEvent }),
            ].filter(Boolean).join(' · ')}
          </span>
        </div>
        {s.short_cups > 0 ? (
          <StatusChip status="short">{t('admin.kegs.cupsShort', { count: s.short_cups })}</StatusChip>
        ) : (
          <StatusChip status="matches" />
        )}
      </div>
      <div className="a-tiles">
        <div className="a-tile">
          <span className="a-tile-label">{t('kegs.expected')}</span>
          <span className="a-tile-money">{t('kegs.cups', { count: s.expected_cups })}</span>
          <span className="a-note">{t('admin.kegs.expectedHow', { litres: litres(keg.volume_ml), cup: keg.cup_ml })}</span>
        </div>
        <div className="a-tile">
          <span className="a-tile-label">{t('kegs.recorded')}</span>
          <span className="a-tile-money">{t('kegs.cups', { count: s.recorded_cups })}</span>
          <span className="a-note">{t('admin.kegs.recordedHow', { mugs, jugs, per: jugSize ? jugSize.deduct / keg.cup_ml : 4 })}</span>
        </div>
        <div className={`a-tile${s.short_cups > 0 ? ' k-tone-error a-tone-tile' : ''}`}>
          <span className="a-tile-label is-strong">{t('kegs.notRecorded')}</span>
          <span className="a-tile-money">{t('kegs.cups', { count: s.short_cups })}</span>
          <span>{t('admin.kegs.value', { amount: formatKES(s.short_value_kes), mug: formatKES(s.mug_price_kes) })}</span>
        </div>
      </div>
      {s.by_server.length > 0 && (
        <div className="a-table-wrap">
          <table className="a-table a-table-keg">
            <thead>
              <tr>
                <th scope="col">{t('admin.kegs.byServer')}</th>
                <th scope="col">{t('admin.kegs.mugs')}</th>
                <th scope="col">{t('admin.kegs.jugs')}</th>
                <th scope="col">{t('admin.kegs.cupsCol')}</th>
              </tr>
            </thead>
            <tbody>
              {s.by_server.map((r) => (
                <tr key={r.person_id}>
                  <th scope="row">{personName(data.people, r.person_id)}</th>
                  <td>{r.mugs}</td>
                  <td>{r.jugs}</td>
                  <td>{r.cups}</td>
                </tr>
              ))}
              <tr className="is-total">
                <th scope="row">{t('common.total')}</th>
                <td>{mugs}</td>
                <td>{jugs}</td>
                <td>{s.recorded_cups}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="a-info">{t('admin.kegs.foam', { count: data.bar.keg_foam_allowance_cups })}</p>
      {keg.checked_at ? (
        <div className="a-decided is-yes">
          <Icon name="check" size={18} strokeWidth={2.4} />
          {keg.written_off_cups
            ? t('admin.kegs.writtenOff', { count: keg.written_off_cups, name: personName(data.people, keg.checked_by), time: hhmm(keg.checked_at) })
            : t('admin.kegs.checked', { name: personName(data.people, keg.checked_by), time: hhmm(keg.checked_at) })}
        </div>
      ) : (
        <div className="a-actions is-center">
          {s.short_cups > 0 && <button type="button" className="a-btn a-btn-primary" onClick={() => check(s.short_cups)}>{t('kegs.writeOff', { count: s.short_cups })}</button>}
          <button type="button" className="a-btn" onClick={() => check(0)}>{t(s.short_cups > 0 ? 'kegs.markChecked' : 'admin.kegs.markOk')}</button>
          <Link className="a-link" to={`/admin/audit?q=${keg.id}&day=`}>{t('admin.kegs.everySale')}</Link>
        </div>
      )}
    </section>
  );
}

/** Kegs (Kegs.dc.html): what's on tap, the queue, and the summary of a finished keg (R-KEG-1…3). */
export function KegsScreen() {
  const { t, locale } = useI18n();
  const db = useDb();
  const { ctx, now } = useAdmin();
  const clock = useNow();
  const today = businessDayOf(clock);
  const data = useDayData(today);
  const deliveries = useQuery((d) => d.deliveries.toArray());
  if (!data) return <AdminLayout>{null}</AdminLayout>;
  const kegProducts = data.products.filter((p) => data.kegs.some((k) => k.product_id === p.id) || p.category_id === 'keg');
  const finished = data.kegs.filter((k) => k.status === 'finished').sort((a, b) => (b.finished_at ?? '').localeCompare(a.finished_at ?? ''));
  const toCheck = finished.filter((k) => !k.checked_at);
  const recent = finished.filter((k) => k.checked_at).slice(0, 3);

  return (
    <AdminLayout>
      <PageTitle title={t('kegs.title')} />
      {kegProducts.length === 0 && <p className="a-muted">{t('admin.kegs.none')}</p>}
      {kegProducts.map((product) => {
        const active = data.kegs.find((k) => k.product_id === product.id && k.status === 'active');
        const queue = data.kegs.filter((k) => k.product_id === product.id && k.status === 'queued').sort((a, b) => a.code.localeCompare(b.code));
        const s = active ? kegSummary(active, { ...data, ...(data.kegSales ?? {}) }) : null;
        const pct = active && s ? Math.round((s.remaining_ml / active.volume_ml) * 100) : 0;
        const kegLines = active ? (data.kegSales?.lines ?? []).filter((l) => l.keg_id === active.id && l.status !== 'voided') : [];
        const mugs = kegLines.filter((l) => data.sizes.find((x) => x.id === l.size_id)?.deduct === active?.cup_ml).reduce((n, l) => n + l.qty, 0);
        const jugs = kegLines.reduce((n, l) => n + l.qty, 0) - mugs;
        const finish = async () => {
          if (!active) return;
          const next = nextQueuedKeg(data.kegs, product.id);
          await recordAdminEvent(db, ctx, { type: 'keg_finished', payload: { keg_id: active.id, finished_at: now().toISOString(), next_keg_id: next?.id ?? null } });
        };
        return (
          <div key={product.id} className="a-row">
            <section className="a-card a-keg-tap a-grow-1" aria-labelledby={`tap-${product.id}`}>
              {active && s ? (
                <>
                  <div className="a-keg-level" role="img" aria-label={t('admin.kegs.levelAria', { pct })}>
                    <div style={{ height: `${pct}%` }} />
                  </div>
                  <div className="a-keg-info">
                    <StatusChip status="paid" className="a-chip-sm">{t('kegs.onTap')}</StatusChip>
                    <h2 id={`tap-${product.id}`}>{productName(product, locale)} #{active.code}</h2>
                    <div className="a-keg-left">
                      {t('kegs.left', { litres: litres(s.remaining_ml) })} <span>{t('admin.kegs.of', { litres: litres(active.volume_ml) })}</span>
                    </div>
                    <p className="a-note">
                      {t('admin.kegs.since', {
                        when: active.tapped_at ? when(active.tapped_at, today, data.bar.day_start, t, locale) : '—',
                        mugs, jugs, litres: litres(s.recorded_ml),
                      })}
                    </p>
                    <button type="button" className="a-btn" onClick={finish}>{t('kegs.finished')}</button>
                  </div>
                </>
              ) : (
                <div className="a-keg-info">
                  <h2 id={`tap-${product.id}`}>{productName(product, locale)}</h2>
                  <p className="a-note">{queue.length ? t('admin.kegs.noneOnTapQueue') : t('admin.kegs.noneOnTap')}</p>
                  <Link className="a-btn a-btn-sm" to="/admin/stock/new?product=keg">{t('action.addStock')}</Link>
                </div>
              )}
            </section>
            <section className="a-card a-grow-1" aria-labelledby={`queue-${product.id}`}>
              <h2 id={`queue-${product.id}`}>{t('kegs.queue')}</h2>
              {queue.length === 0 && <p className="a-muted">{t('admin.kegs.queueEmpty')}</p>}
              {queue.map((k, i) => {
                const delivery = deliveries?.find((d) => d.keg_ids.includes(k.id));
                const arrived = delivery
                  ? [t('admin.kegs.arrived', { when: when(delivery.created_at, today, data.bar.day_start, t, locale) }), delivery.note_no].filter(Boolean).join(', ')
                  : null;
                return (
                  <div key={k.id} className="a-queue-row">
                    <span className="a-queue-n">{i + 1}</span>
                    <span>
                      <strong>{productName(product, locale)} #{k.code} · {litres(k.volume_ml)} L</strong>
                      <span>{[arrived, i === 0 ? t('admin.kegs.next') : t('admin.kegs.waiting')].filter(Boolean).join(' · ')}</span>
                    </span>
                  </div>
                );
              })}
              <p className="a-note">{t('admin.kegs.queueNote')}</p>
            </section>
          </div>
        );
      })}
      {toCheck.map((k) => <KegSummaryCard key={k.id} keg={k} data={data} today={today} />)}
      {recent.map((k) => <KegSummaryCard key={k.id} keg={k} data={data} today={today} />)}
    </AdminLayout>
  );
}
