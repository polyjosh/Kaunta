import { useState } from 'react';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { productName, displayLabel, sizeLabel } from '../counter/labels';
import { recordAdminEvent, UNDO_GRACE_MS } from '../data/adminEvents';
import type { Decision } from '../data/adminEvents';
import { useDb } from '../data/react';
import { minutesBetween } from '../domain/time';
import type { ApprovalItem, VoidReason } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import type { TFunction } from '../lib/I18nProvider';
import type { Locale, MessageKey } from '../lib/i18n';
import { formatKES } from '../lib/money';
import { AdminLayout, PageTitle } from './AdminLayout';
import { useAdmin, useNow } from './AdminSession';
import { deviceName, hhmm, personName, useDayData } from './data';
import type { AdminDay } from './data';
import { itemsText } from './TodayScreen';
import { businessDayOf } from '../domain/time';

const KIND: Record<ApprovalItem['kind'], { label: MessageKey; tone: string; icon: IconName }> = {
  void: { label: 'approvals.kind.void', tone: 'neutral', icon: 'ban' },
  write_off: { label: 'approvals.kind.writeOff', tone: 'written-off', icon: 'archive' },
  comp: { label: 'approvals.kind.comp', tone: 'written-off', icon: 'gift' },
  price_mismatch: { label: 'approvals.kind.priceMismatch', tone: 'warning', icon: 'alert-triangle' },
  archived_product: { label: 'admin.kind.archived', tone: 'warning', icon: 'alert-triangle' },
  revoked_device: { label: 'admin.kind.revoked', tone: 'warning', icon: 'alert-triangle' },
  expense: { label: 'admin.kind.expense', tone: 'neutral', icon: 'list' },
};

const VOID_REASONS: VoidReason[] = ['mistake', 'changed', 'size', 'spilled', 'other'];

function reasonText(a: ApprovalItem, t: TFunction): string {
  const base = (VOID_REASONS as string[]).includes(a.reason_code) ? t(`void.reason.${a.reason_code}` as MessageKey) : a.reason_code;
  if (!a.note) return base;
  return a.reason_code === 'other' ? a.note : `${base}, ${a.note}`;
}

interface CardView {
  title: string;
  facts: [string, string][];
  effect: string;
  yes: string;
  no: string;
  decidedYes: string;
  decidedNo: string;
}

export function approvalCard(a: ApprovalItem, data: AdminDay, t: TFunction, locale: Locale): CardView {
  const order = data.orders.find((o) => o.id === a.target.order_id) ?? data.kegSales?.orders.find((o) => o.id === a.target.order_id);
  const orderName = order ? `${order.short_no} ${displayLabel(order.label, t)}` : '';
  const lines = a.target.line_ids.map((id) => data.lines.find((l) => l.id === id)).filter((l) => l !== undefined);
  const items = itemsText(a, data, locale, true);
  const who = personName(data.people, a.requested_by);
  const device = deviceName(data.devices, a.device_id) ?? '';
  const asked = [who, hhmm(a.requested_at), device].filter(Boolean).join(' · ');
  const amount = formatKES(a.amount_kes);
  const qty = (lines.reduce((s, l) => s + l.qty, 0) || a.target.item?.qty) ?? 0;
  const item = a.target.item;
  const itemProduct = item ? data.products.find((p) => p.id === item.product_id) : undefined;
  const itemSize = item ? data.sizes.find((s) => s.id === item.size_id) : undefined;
  const unit = (p = itemProduct) => (p?.stock_mode === 'ml' ? 'ml' : t('admin.unit.bottles'));
  const plain = { yes: t('approvals.approve'), no: t('approvals.reject'), decidedYes: t('admin.decided.approved'), decidedNo: t('admin.decided.rejected') };

  switch (a.kind) {
    case 'void': {
      const first = lines[0];
      const recorded = first
        ? a.target.whole_order
          ? t('admin.fact.recordedItems', { time: hhmm(order?.created_at ?? first.created_at), count: qty })
          : minutesBetween(first.created_at, a.requested_at) > data.bar.self_void_minutes
            ? t('admin.fact.recordedLate', { time: hhmm(first.created_at), minutes: data.bar.self_void_minutes })
            : hhmm(first.created_at)
        : '';
      return {
        ...plain,
        yes: t('admin.approveVoid'),
        decidedYes: t('admin.decided.voidApproved'),
        title: a.target.whole_order ? `${orderName} · ${t('admin.wholeOrder')}` : `${orderName} · ${items}`,
        facts: [[t('approvals.askedBy'), asked], [t('admin.fact.recorded'), recorded], [t('approvals.reason'), reasonText(a, t)]],
        effect: a.target.whole_order
          ? t('admin.effect.voidWhole', { no: order?.short_no ?? '', count: qty })
          : t('admin.effect.void', { amount, no: order?.short_no ?? '', items }),
      };
    }
    case 'write_off':
      return {
        ...plain,
        yes: t('admin.approveWriteOff'),
        decidedYes: t('admin.decided.writeOffApproved'),
        title: `${items} · ${t('admin.broken')}`,
        facts: [
          [t('admin.fact.reportedBy'), asked],
          [t('approvals.reason'), reasonText(a, t)],
          ...(item ? [[t('admin.fact.stock'), t('admin.fact.alreadyOff', { qty: item.qty * (itemSize?.deduct ?? 1), unit: unit() })] as [string, string]] : []),
        ],
        effect: item
          ? t('admin.effect.writeOffItem', { amount, qty: item.qty * (itemSize?.deduct ?? 1), unit: unit() })
          : t('admin.effect.writeOffLines', { amount, no: order?.short_no ?? '' }),
      };
    case 'comp':
      return {
        ...plain,
        yes: t('admin.approveComp'),
        decidedYes: t('admin.decided.compApproved'),
        title: `${order ? `${displayLabel(order.label, t)} · ` : ''}${items} ${t('admin.onTheHouse')}`,
        facts: [
          [t('approvals.askedBy'), asked],
          [t('approvals.reason'), reasonText(a, t)],
          ...(order ? [[t('admin.fact.order'), order.status === 'paid' ? t('admin.fact.orderPaid', { no: order.short_no }) : order.short_no] as [string, string]] : []),
        ],
        effect: t('admin.effect.comp', { amount, item: itemSize ? sizeLabel(itemSize, locale) : '' }),
      };
    case 'price_mismatch': {
      const d = (a.detail ?? {}) as { recorded_price_kes?: number; server_price_kes?: number; server_price_since?: string };
      const recorded = formatKES(d.recorded_price_kes ?? 0);
      const product = itemProduct ?? data.products.find((p) => p.id === lines[0]?.product_id);
      const sold = lines[0] ?? null;
      return {
        title: t('admin.priceTitle', { order: orderName, product: product ? productName(product, locale) : '' }),
        facts: [
          [t('admin.fact.sold'), sold ? t('admin.fact.soldOffline', { time: hhmm(sold.created_at), device }) : device],
          [t('admin.fact.price'), d.server_price_since
            ? t('admin.fact.priceSince', { recorded, price: formatKES(d.server_price_kes ?? 0), since: hhmm(d.server_price_since) })
            : t('admin.fact.priceNow', { recorded, price: formatKES(d.server_price_kes ?? 0) })],
          [t('common.server'), personName(data.people, order?.server_id)],
        ],
        effect: t('admin.effect.price', { recorded, amount }),
        yes: t('admin.accept', { amount: recorded }),
        no: t('admin.markShort', { amount }),
        decidedYes: t('admin.decided.accepted', { amount: recorded }),
        decidedNo: t('admin.decided.markedShort', { amount }),
      };
    }
    case 'archived_product':
      return {
        ...plain,
        title: `${orderName} · ${items}`,
        facts: [[t('admin.fact.sold'), asked]],
        effect: t('admin.effect.archived', { amount }),
        yes: t('admin.keepSale'),
        decidedYes: t('admin.decided.kept'),
      };
    case 'expense': {
      const label = String((a.detail as { label?: string } | null)?.label ?? '');
      const shift = data.shifts.find((s) => s.id === a.target.shift_id);
      const fromTill = a.reason_code === 'mpesa';
      return {
        ...plain,
        title: label,
        facts: [
          [t('approvals.askedBy'), asked],
          [t('expense.from'), t(fromTill ? 'expense.fromTill' : 'expense.fromCash')],
          ...(shift ? [[t('admin.fact.shift'), `${personName(data.people, shift.person_id)} · ${hhmm(shift.opened_at)} – ${shift.closed_at ? hhmm(shift.closed_at) : t('admin.recon.stillOpen')}`] as [string, string]] : []),
        ],
        effect: t(fromTill ? 'admin.effect.expenseTill' : 'admin.effect.expenseCash', { amount, name: who }),
      };
    }
    case 'revoked_device':
      return {
        ...plain,
        title: t('admin.revokedTitle', { device }),
        facts: [[t('admin.fact.sentBy'), asked]],
        effect: t('admin.effect.revoked', { amount }),
        yes: t('admin.applyIt'),
        decidedYes: t('admin.decided.applied'),
      };
  }
}

/** Approvals inbox (Approvals.dc.html). Decisions apply at once; Undo for a short while, then final. */
export function ApprovalsScreen() {
  const { t, locale } = useI18n();
  const db = useDb();
  const { ctx, now } = useAdmin();
  const clock = useNow(5_000);
  const day = businessDayOf(clock);
  const data = useDayData(day);
  const [error, setError] = useState<string | null>(null);

  if (!data) return <AdminLayout wide={false}>{null}</AdminLayout>;
  const waiting = data.approvals.filter((a) => a.status === 'waiting').sort((a, b) => a.requested_at.localeCompare(b.requested_at));
  // Decided ones stay in view for the business day, newest decision first.
  const decided = data.approvals
    .filter((a) => (a.status === 'approved' || a.status === 'rejected') && a.decided_at && businessDayOf(a.decided_at, data.bar.day_start) === day)
    .sort((a, b) => b.decided_at!.localeCompare(a.decided_at!));

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const decide = (a: ApprovalItem, decision: Decision) =>
    act(() => recordAdminEvent(db, ctx, { type: 'approval_decided', payload: { approval_id: a.id, decision, decided_at: now().toISOString() } }));
  const undo = (a: ApprovalItem) => act(() => recordAdminEvent(db, ctx, { type: 'approval_undone', payload: { approval_id: a.id } }));

  return (
    <AdminLayout wide={false}>
      <PageTitle title={t('approvals.title')} aside={waiting.length ? t('approvals.waiting', { count: waiting.length }) : t('approvals.allDone')} />
      {error && <p className="a-error" role="alert">{error}</p>}
      {waiting.length === 0 && decided.length === 0 && (
        <div className="a-card a-empty">
          <Icon name="check-circle" size={40} />
          <p>{t('approvals.allDone')}</p>
        </div>
      )}
      {[...waiting, ...decided].map((a) => {
        const kind = KIND[a.kind];
        const card = approvalCard(a, data, t, locale);
        const open = a.status === 'waiting';
        const canUndo = !open && a.decided_at !== null && clock.getTime() - Date.parse(a.decided_at) <= UNDO_GRACE_MS;
        const yes = a.status === 'approved';
        return (
          <article key={a.id} className="a-card a-approval" aria-labelledby={`ap-${a.id}`}>
            <div className="a-approval-head">
              <span className={`k-chip k-tone-${kind.tone} a-chip-sm`}>
                <Icon name={kind.icon} size={16} />
                <span>{t(kind.label)}</span>
              </span>
              <h2 id={`ap-${a.id}`}>{card.title}</h2>
              <span className="a-approval-amount">{formatKES(a.amount_kes)}</span>
            </div>
            <dl className="a-facts">
              {card.facts.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="a-effect">{card.effect}</p>
            {open ? (
              <div className="a-actions">
                <button type="button" className="a-btn a-btn-primary" onClick={() => decide(a, 'approved')}>{card.yes}</button>
                <button type="button" className="a-btn" onClick={() => decide(a, 'rejected')}>{card.no}</button>
              </div>
            ) : (
              <div className={`a-decided ${yes ? 'is-yes' : 'is-no'}`}>
                <Icon name={yes ? 'check' : 'close'} size={18} strokeWidth={2.4} />
                <span>
                  {yes ? card.decidedYes : card.decidedNo} · {personName(data.people, a.decided_by)} ·{' '}
                  {canUndo ? t('admin.now') : hhmm(a.decided_at!)}
                </span>
                {canUndo && (
                  <button type="button" className="a-text-btn" onClick={() => undo(a)}>
                    {t('common.undo')}
                  </button>
                )}
              </div>
            )}
          </article>
        );
      })}
    </AdminLayout>
  );
}
