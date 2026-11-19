import { useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { useConnection, useDb, useQuery } from '../data/react';
import { voidLines } from '../data/voids';
import { orderTotal, paidTotal } from '../domain/orders';
import { localTime, minutesBetween } from '../domain/time';
import type { Id, VoidReason } from '../domain/types';
import { VOID_REASONS, clockMinutes, selfVoidMsLeft, voidRoute } from '../domain/voids';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { formatKES } from '../lib/money';
import { displayLabel, productName, sizeLabel } from './labels';
import { useSession } from './Session';
import { BackBar, useNow, withOffline } from './ui';
import type { ToastMessage } from './ui';

const REASON: Record<VoidReason, { label: MessageKey; note?: MessageKey }> = {
  mistake: { label: 'void.reason.mistake' },
  changed: { label: 'void.reason.changed', note: 'void.reason.changedNote' },
  size: { label: 'void.reason.size' },
  spilled: { label: 'void.reason.spilled', note: 'void.reason.spilledNote' },
  other: { label: 'void.reason.other', note: 'void.reason.otherNote' },
};

/** What to void: one unit of a line, or the whole order. */
type Scope = { kind: 'line'; lineId: Id } | { kind: 'order' };

/** Screen 5: void one item or the whole order, by yourself or via an admin. Rules R-VOID-1…4. */
export function VoidScreen() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { t, locale } = useI18n();
  const db = useDb();
  const session = useSession();
  const navigate = useNavigate();
  const now = useNow(1000); // the window counts down live
  const preset = params.get('line');
  const [scope, setScope] = useState<Scope | null>(preset ? { kind: 'line', lineId: preset } : null);
  const [reason, setReason] = useState<VoidReason | null>(null);
  const busy = useRef(false);
  const { online } = useConnection();

  const data = useQuery(
    async (d) => {
      const order = await d.orders.get(id);
      if (!order) return null;
      const [bar, lines, people, products, sizes, payments] = await Promise.all([
        d.bar.toCollection().first(),
        d.lines.where('order_id').equals(id).sortBy('created_at'),
        d.people.toArray(),
        d.products.toArray(),
        d.sizes.toArray(),
        d.payments.where('order_id').equals(id).toArray(),
      ]);
      return { order, bar, lines, people, products, sizes, payments };
    },
    [id],
  );
  const me = session.person;
  if (!data || !me) return null;

  const { order } = data;
  const back = `/counter/orders/${order.id}`;
  const active = data.lines.filter((line) => line.status === 'active');
  const nameOf = (personId: Id) => data.people.find((p) => p.id === personId)?.name ?? '';
  const describe = (lineId: Id) => {
    const line = active.find((l) => l.id === lineId);
    const product = line && data.products.find((p) => p.id === line.product_id);
    const size = line && data.sizes.find((s) => s.id === line.size_id);
    return {
      line,
      name: product ? productName(product, locale) : '',
      full: `${product ? productName(product, locale) : ''} ${size ? sizeLabel(size, locale) : ''}`.trim(),
    };
  };

  const chosen = scope?.kind === 'line' ? active.filter((l) => l.id === scope.lineId) : scope ? active : [];
  // Before anything is chosen, the banner speaks for the whole order.
  const windowLines = chosen.length > 0 ? chosen : active;
  const msLeft = selfVoidMsLeft(windowLines, me.id, now, data.bar?.self_void_minutes ?? 2);
  const oldest = windowLines.reduce((min, l) => (l.created_at < min ? l.created_at : min), windowLines[0]?.created_at ?? order.created_at);
  // Voiding below what was already paid means giving money back: always an admin's call (as voidLines decides).
  // One unit of a line, or every active line (what submit sends).
  const voidAmount = scope?.kind === 'line' ? (chosen[0]?.unit_price_kes ?? 0) : orderTotal(active);
  const moneyAtStake = paidTotal(data.payments) > orderTotal(data.lines) - voidAmount;
  const selfWindow = msLeft > 0 && !moneyAtStake;
  // The live window switches the variant by itself; the chosen reason is kept.
  const needsAdmin = reason ? voidRoute(reason, msLeft, moneyAtStake).route === 'approval' : !selfWindow;

  const orderRef = `${displayLabel(order.label, t)} ${order.short_no}`;
  const target = scope?.kind === 'line' ? describe(scope.lineId) : null;
  const ready = Boolean(scope && reason && chosen.length > 0);
  const whatName = scope?.kind === 'order' ? lowerFirst(t('void.wholeOrder', { no: order.short_no })) : (target?.name ?? '');

  const submit = async () => {
    if (!ready || !scope || !reason || busy.current) return;
    busy.current = true;
    try {
      const outcome = await voidLines(db, session.recordContext(), {
        order_id: order.id,
        items: scope.kind === 'line' ? [{ line_id: scope.lineId, qty: 1 }] : [],
        whole_order: scope.kind === 'order',
        reason,
      });
      const toast: ToastMessage =
        outcome.route === 'approval'
          ? { text: t('void.toastSent'), tone: 'warning' }
          : { text: t('void.toastDone', { name: whatName, order: orderRef }) };
      // A fully voided order is no longer open: go back to the list instead.
      const gone = outcome.route === 'self' && scope.kind === 'order';
      navigate(gone ? '/counter/orders' : back, { replace: true, state: { toast: withOffline(toast, online, t) } });
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="c-screen">
      <BackBar to={back} title={t('void.title', { order: orderRef })} />

      <main className="c-body c-void">
        {selfWindow ? (
          <div className="c-banner k-tone-pending">
            <Icon name="clock" size={26} />
            <div>
              <strong>{t('void.selfHead')}</strong>
              <p>
                {t('void.selfBody', {
                  ago: clockMinutes(now.getTime() - Date.parse(oldest)),
                  left: clockMinutes(msLeft),
                })}
              </p>
            </div>
          </div>
        ) : moneyAtStake ? (
          <div className="c-banner k-tone-warning">
            <Icon name="alert-triangle" size={26} />
            <div>
              <strong>{t('void.paidHead')}</strong>
              <p>{t('void.paidBody')}</p>
            </div>
          </div>
        ) : (
          <div className="c-banner k-tone-warning">
            <Icon name="alert-triangle" size={26} />
            <div>
              <strong>{t('void.adminHead')}</strong>
              <p>{t('void.adminBody', { ago: t('common.minutes', { count: minutesBetween(oldest, now) }) })}</p>
            </div>
          </div>
        )}

        <section className="c-radio-group">
          <h2 className="c-section-head" id="void-what">
            {t('void.what')}
          </h2>
          <div role="radiogroup" aria-labelledby="void-what" className="c-rows">
            {active.map((line) => {
              const { full } = describe(line.id);
              const on = scope?.kind === 'line' && scope.lineId === line.id;
              return (
                <button
                  key={line.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className="c-radio c-radio-tall"
                  onClick={() => setScope({ kind: 'line', lineId: line.id })}
                >
                  <span className="c-radio-dot" />
                  <span className="c-radio-text">
                    <strong>{full} ×1</strong>
                    <span>
                      {localTime(line.created_at)} · {nameOf(line.recorded_by)}
                    </span>
                  </span>
                  <span className="c-radio-amount">{formatKES(line.unit_price_kes)}</span>
                </button>
              );
            })}
            <button
              type="button"
              role="radio"
              aria-checked={scope?.kind === 'order'}
              className="c-radio c-radio-tall"
              onClick={() => setScope({ kind: 'order' })}
            >
              <span className="c-radio-dot" />
              <span className="c-radio-text">
                <strong>{t('void.wholeOrder', { no: order.short_no })}</strong>
                <span>{t('common.items', { count: active.reduce((sum, l) => sum + l.qty, 0) })}</span>
              </span>
              <span className="c-radio-amount">{formatKES(orderTotal(active))}</span>
            </button>
          </div>
        </section>

        <section className="c-radio-group">
          <h2 className="c-section-head" id="void-why">
            {t('void.why')}
          </h2>
          <div role="radiogroup" aria-labelledby="void-why" className="c-rows">
            {VOID_REASONS.map((r) => {
              const { label, note } = REASON[r];
              return (
                <button key={r} type="button" role="radio" aria-checked={reason === r} className="c-radio" onClick={() => setReason(r)}>
                  <span className="c-radio-dot" />
                  <span className="c-radio-text">
                    <strong>{t(label)}</strong>
                    {note && <span>{t(note)}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <p className="c-footnote">
          {t('void.footnote', { name: nameOf(windowLines[0]?.recorded_by ?? order.recorded_by), device: session.device?.name ?? '' })}
        </p>
      </main>

      <footer className="c-bottom c-bottom-stack">
        <button
          type="button"
          className={`c-btn c-void-btn${!ready ? '' : needsAdmin ? ' is-admin' : ' is-void'}`}
          disabled={!ready}
          onClick={() => void submit()}
        >
          {!ready ? t('void.pickReason') : needsAdmin ? t('void.sendAdmin') : t('void.voidItem', { name: whatName })}
        </button>
        <button type="button" className="c-btn c-btn-link" onClick={() => navigate(back)}>
          {t('common.cancel')}
        </button>
      </footer>
    </div>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
