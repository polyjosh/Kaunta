import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { attentionFlags, byServer, salesByHour, todaySummary } from '../domain/admin';
import type { Flag } from '../domain/admin';
import { businessDayOf } from '../domain/time';
import type { ApprovalItem } from '../domain/types';
import { productName, sizeLabel } from '../counter/labels';
import { useI18n } from '../lib/I18nProvider';
import type { TFunction } from '../lib/I18nProvider';
import type { Locale } from '../lib/i18n';
import { formatKES } from '../lib/money';
import { AdminLayout, PageTitle } from './AdminLayout';
import { BarCodeCard } from './BarCodeCard';
import { FirstRun } from './FirstRun';
import { useNow } from './AdminSession';
import { hhmm, personName, useDayData } from './data';
import type { AdminDay } from './data';

type Tone = 'error' | 'warning' | 'written-off';

interface FlagView {
  key: string;
  tone: Tone;
  icon: IconName;
  title: string;
  body: string;
  cta: string;
  to: string;
}

/** "#039 Guinness ×1 (Otieno)" / "#041 whole order (Akinyi)". */
export function approvalShort(a: ApprovalItem, data: AdminDay, t: TFunction, locale: Locale): string {
  const order = data.orders.find((o) => o.id === a.target.order_id);
  const no = order ? `${order.short_no} ` : '';
  const who = personName(data.people, a.requested_by);
  if (a.target.whole_order) return `${no}${t('admin.wholeOrder')} (${who})`;
  const item = itemsText(a, data, locale);
  return `${no}${item}${a.requested_by === 'system' ? '' : ` (${who})`}`;
}

/** "Guinness ×1", "Tusker Lager 500ml ×2" for what an approval is about. */
export function itemsText(a: ApprovalItem, data: Pick<AdminDay, 'lines' | 'products' | 'sizes'>, locale: Locale, withSize = false): string {
  const parts = a.target.item
    ? [{ product_id: a.target.item.product_id, size_id: a.target.item.size_id, qty: a.target.item.qty }]
    : a.target.line_ids.map((id) => data.lines.find((l) => l.id === id)).filter((l) => l !== undefined);
  return parts
    .map((p) => {
      const product = data.products.find((x) => x.id === p.product_id);
      const size = data.sizes.find((s) => s.id === p.size_id);
      const name = product ? productName(product, locale) : p.product_id;
      return `${name}${withSize && size ? ` ${sizeLabel(size, locale)}` : ''} ×${p.qty}`;
    })
    .join(', ');
}

function flagView(flag: Flag, data: AdminDay, t: TFunction, locale: Locale): FlagView {
  switch (flag.kind) {
    case 'negativeStock': {
      const product = data.products.find((p) => p.id === flag.product_id)!;
      const unit = product.stock_mode === 'ml' ? 'ml' : t('admin.unit.bottles');
      const size = flag.size_id ? data.sizes.find((s) => s.id === flag.size_id) : undefined;
      const name = size ? `${productName(product, locale)} ${sizeLabel(size, locale)}` : productName(product, locale);
      return {
        key: `stock-${product.id}${size ? `-${size.id}` : ''}`, tone: 'error', icon: 'box', to: `/admin/stock/new?product=${product.id}`,
        // A count, not money, so it may carry a minus sign.
        title: t('today.flag.negativeStock', { product: name, qty: `−${Math.abs(flag.qty)}`, unit }),
        body: t('today.flag.negativeStockBody'), cta: t('action.addStock'),
      };
    }
    case 'voids':
      return {
        key: 'voids', tone: 'warning', icon: 'ban', to: '/admin/approvals',
        title: t('today.flag.voids', { count: flag.approvals.length, amount: formatKES(flag.amount_kes) }),
        body: flag.approvals.map((a) => approvalShort(a, data, t, locale)).join(' · '), cta: t('action.review'),
      };
    case 'writeOffs': {
      const a = flag.approvals[0]!;
      return {
        key: 'writeoffs', tone: 'written-off', icon: 'archive', to: '/admin/approvals',
        title: t('today.flag.writeOffs', { count: flag.approvals.length, amount: formatKES(flag.amount_kes) }),
        body: flag.approvals.length === 1
          ? t('admin.flag.writeOffBody', { items: itemsText(a, data, locale), name: personName(data.people, a.requested_by), time: hhmm(a.requested_at) })
          : flag.approvals.map((x) => approvalShort(x, data, t, locale)).join(' · '),
        cta: t('action.review'),
      };
    }
    case 'priceMismatch': {
      const a = flag.approvals[0]!;
      const order = data.orders.find((o) => o.id === a.target.order_id);
      const d = a.detail as { recorded_price_kes?: number; server_price_kes?: number } | null;
      const product = data.products.find((p) => p.id === data.lines.find((l) => l.id === a.target.line_ids[0])?.product_id);
      return {
        key: 'price', tone: 'warning', icon: 'alert-triangle', to: '/admin/approvals',
        title: t('today.flag.priceMismatch', { count: flag.approvals.length }),
        body: flag.approvals.length === 1 && a.kind === 'price_mismatch' && d?.recorded_price_kes !== undefined && d.server_price_kes !== undefined
          ? t('admin.flag.priceBody', { no: order?.short_no ?? '', product: product ? productName(product, locale) : '', recorded: formatKES(d.recorded_price_kes), price: formatKES(d.server_price_kes) })
          : flag.approvals.map((x) => approvalShort(x, data, t, locale)).join(' · '),
        cta: t('action.decide'),
      };
    }
    case 'kegShort':
      return {
        key: `keg-${flag.keg.id}`, tone: 'error', icon: 'keg', to: `/admin/kegs?keg=${flag.keg.id}`,
        title: t('today.flag.kegShort', { count: flag.short_cups }),
        body: t('admin.flag.kegBody', { code: flag.keg.code, expected: flag.expected_cups, recorded: flag.recorded_cups, amount: formatKES(flag.value_kes) }),
        cta: t('action.seeKeg'),
      };
    case 'shiftShort':
      return {
        key: `shift-${flag.shift.id}`, tone: 'error', icon: 'x-circle', to: `/admin/reconcile/${businessDayOf(flag.shift.opened_at, data.bar.day_start)}`,
        title: t('today.flag.shiftShort', { name: personName(data.people, flag.shift.person_id), amount: formatKES(flag.amount_kes) }),
        body: t('admin.flag.shiftBody', { time: hhmm(flag.shift.closed_at!) }), cta: t('nav.reconcile'),
      };
  }
}

/** Today (Today.dc.html): "Did I lose money today?" answered from the records (R-DAY-4). */
export function TodayScreen() {
  const { t, locale } = useI18n();
  const now = useNow();
  const dayStart = '06:00';
  const day = businessDayOf(now, dayStart);
  const data = useDayData(day);

  if (!data) return <AdminLayout>{null}</AdminLayout>;
  // A new bar: nothing to sell yet, so nothing to report. Start the menu here.
  if (data.products.length === 0) {
    return (
      <AdminLayout>
        <PageTitle title={t('today.title')} />
        <FirstRun />
        <BarCodeCard />
      </AdminLayout>
    );
  }
  const s = todaySummary(data);
  const flags = attentionFlags(data, day).map((f) => flagView(f, data, t, locale));
  const hours = salesByHour(data, data.bar.day_start);
  const peak = hours.reduce((best, h) => (h.amount_kes > (best?.amount_kes ?? -1) ? h : best), hours[0]);
  const servers = byServer(data);
  const topServer = servers[0]?.served_kes ?? 0;
  const total = s.cash_kes + s.mpesa_kes;
  const cashPct = total > 0 ? Math.round((s.cash_kes / total) * 1000) / 10 : 0;
  const currentHour = hhmm(now.toISOString()).slice(0, 2);

  const answer =
    s.money_at_risk_kes > 0
      ? t('today.answerAtRisk', { amount: formatKES(s.money_at_risk_kes), orders: s.open_orders, flags: flags.length })
      : flags.length > 0
        ? t('admin.answerFlagsOnly', { count: flags.length })
        : t('today.answerClear');

  return (
    <AdminLayout>
      <PageTitle title={t('today.title')} aside={t('today.asOf', { time: hhmm(now.toISOString()) })} />

      <section className="a-hero" aria-labelledby="today-q">
        <div className="a-hero-text">
          <h2 id="today-q">{t('today.question')}</h2>
          <p>{answer}</p>
        </div>
        <div className="a-hero-tiles">
          <div className="a-hero-tile">
            <span className="a-hero-label">{t('today.served')}</span>
            <span className="a-hero-money">{formatKES(s.served_kes)}</span>
            <span className="a-hero-sub">{t('today.servedSub')}</span>
          </div>
          <div className="a-hero-tile">
            <span className="a-hero-label">{t('today.collected')}</span>
            <span className="a-hero-money">{formatKES(s.collected_kes)}</span>
            <span className="a-hero-sub">{t('today.collectedSub')}</span>
          </div>
          <Link className={`a-hero-tile${s.money_at_risk_kes > 0 ? ' is-risk' : ''}`} to={flags.some((f) => f.to === '/admin/approvals') ? '/admin/approvals' : '/admin/sales'}>
            <span className="a-hero-label">
              {s.money_at_risk_kes > 0 && <Icon name="alert-triangle" size={18} strokeWidth={2.4} />}
              {t('today.risk')}
            </span>
            <span className="a-hero-money">{formatKES(s.money_at_risk_kes)}</span>
            <span className="a-hero-sub">{t('today.riskSub', { count: s.open_orders })}</span>
          </Link>
        </div>
      </section>

      <div className="a-row">
        <section className="a-card a-grow-1" aria-labelledby="today-how">
          <h2 id="today-how">{t('today.how')}</h2>
          <div className="a-split" role="img" aria-label={t('admin.splitAria', { cash: cashPct, mpesa: Math.round((100 - cashPct) * 10) / 10 })}>
            <div className="a-split-cash" style={{ width: `${cashPct}%` }} />
            <div className="a-split-gap" />
            <div className="a-split-mpesa" />
          </div>
          <div className="a-legend">
            <span><span className="a-swatch is-cash" />{t('pay.cash')}</span>
            <strong>{formatKES(s.cash_kes)}</strong>
          </div>
          <div className="a-legend">
            <span><span className="a-swatch is-mpesa" />M-Pesa</span>
            <strong>{formatKES(s.mpesa_kes)}</strong>
          </div>
          <p className="a-note a-note-rule">{t('today.howNote')}</p>
          <Link className="a-link" to={`/admin/reconcile/${day}`}>{t('today.reconcile')}</Link>
        </section>

        <section className="a-card a-grow-2" aria-labelledby="today-attention">
          <div className="a-card-head">
            <h2 id="today-attention">{t('today.attention')}</h2>
            <span className="a-muted">{t('common.items', { count: flags.length })}</span>
          </div>
          {flags.length === 0 && <p className="a-muted">{t('admin.nothingNeedsYou')}</p>}
          {flags.map((f) => (
            <Link key={f.key} to={f.to} className={`a-flag k-tone-${f.tone}`}>
              <span className="a-flag-icon"><Icon name={f.icon} size={20} /></span>
              <span className="a-flag-text">
                <strong>{f.title}</strong>
                <span>{f.body}</span>
              </span>
              <span className="a-flag-cta">{f.cta} →</span>
            </Link>
          ))}
        </section>
      </div>

      <div className="a-row">
        <section className="a-card a-grow-2" aria-labelledby="today-hour">
          <div className="a-card-head">
            <h2 id="today-hour">{t('today.byHour')}</h2>
            {peak && <span className="a-muted">{t('today.peak', { hour: `${peak.hour}:00`, amount: formatKES(peak.amount_kes) })}</span>}
          </div>
          <div
            className="a-hours"
            role="img"
            aria-label={hours.length ? t('admin.byHourAria', { from: `${hours[0]!.hour}:00`, to: `${hours[hours.length - 1]!.hour}:00`, peak: `${peak!.hour}:00` }) : t('admin.noSalesYet')}
          >
            {hours.map((h) => (
              <div
                key={h.hour}
                className={`a-hour-bar${h === peak ? ' is-peak' : h.hour === currentHour ? ' is-now' : ''}`}
                style={{ height: `${peak && peak.amount_kes > 0 ? Math.round((h.amount_kes / peak.amount_kes) * 100) : 0}%` }}
                title={`${h.hour}:00 · ${formatKES(h.amount_kes)}`}
              />
            ))}
          </div>
          <div className="a-hour-labels" aria-hidden="true">
            {hours.map((h) => <span key={h.hour}>{h.hour}</span>)}
          </div>
        </section>

        <section className="a-card a-grow-1" aria-labelledby="today-server">
          <h2 id="today-server">{t('today.byServer')}</h2>
          {servers.map((sv) => (
            <div key={sv.person_id} className="a-meter">
              <div className="a-meter-row">
                <span>{personName(data.people, sv.person_id)}</span>
                <strong>{formatKES(sv.served_kes)}</strong>
              </div>
              <div className="a-meter-track"><div style={{ width: `${topServer ? Math.round((sv.served_kes / topServer) * 100) : 0}%` }} /></div>
            </div>
          ))}
          <Link className="a-link" to="/admin/sales">{t('today.seeAll')}</Link>
        </section>
      </div>
    </AdminLayout>
  );
}

