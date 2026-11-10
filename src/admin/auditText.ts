import { displayLabel, productName, sizeLabel } from '../counter/labels';
import { lineTotal } from '../domain/orders';
import type { ApprovalItem, AuditEvent, Delivery, Device, Order, OrderLine, Payment, Person, Product, ProductSize, Shift } from '../domain/types';
import type { TFunction } from '../lib/I18nProvider';
import type { Locale, MessageKey } from '../lib/i18n';
import { formatAmount, formatKES } from '../lib/money';
import { ADMIN_DEVICE } from '../data/adminEvents';
import { hhmm } from './data';

export interface AuditLookups {
  people: Person[];
  devices: Device[];
  products: Product[];
  sizes: ProductSize[];
  orders: Order[];
  lines: OrderLine[];
  approvals: ApprovalItem[];
  kegs: { id: string; code: string }[];
}

export interface AuditText {
  what: string;
  /** before → after, for changes (R-AUD-1). */
  changes: { before: string; after: string; label?: string }[];
}

type Detail = Record<string, any>;

const REASONS = ['mistake', 'changed', 'size', 'spilled', 'other'];

export function auditWho(e: AuditEvent, l: AuditLookups, t: TFunction): string {
  if (e.actor_id === 'system') return t('admin.audit.system');
  return l.people.find((p) => p.id === e.actor_id)?.name ?? e.actor_id;
}

/** "Counter 1", "Admin browser", and "saved offline 02:02, synced 02:11" when it waited on the phone. */
export function auditDevice(e: AuditEvent, l: AuditLookups, t: TFunction): string {
  const name = e.device_id === ADMIN_DEVICE ? t('admin.audit.adminBrowser') : (l.devices.find((d) => d.id === e.device_id)?.name ?? (e.device_id ? e.device_id : ''));
  const late = e.synced_at && Date.parse(e.synced_at) - Date.parse(e.at) > 2 * 60_000;
  const parts = [name, late ? t('admin.audit.savedOffline', { saved: hhmm(e.at), synced: hhmm(e.synced_at!) }) : null];
  if (!e.synced_at && e.device_id === ADMIN_DEVICE) parts.push(t('admin.audit.notSent'));
  return parts.filter(Boolean).join(' · ');
}

/** Says what an audit row records, in the screen's language, from its stored detail. */
export function describeAudit(e: AuditEvent, l: AuditLookups, t: TFunction, locale: Locale): AuditText {
  const d = e.detail as Detail;
  const person = (id: string | null | undefined) => (id ? (l.people.find((p) => p.id === id)?.name ?? id) : '');
  const order = (id: string | null | undefined): Order | undefined => (id ? l.orders.find((o) => o.id === id) : undefined);
  const orderName = (o: Partial<Order> | undefined) => (o ? [o.short_no, o.label !== undefined ? displayLabel(o.label, t) : null].filter(Boolean).join(' ') : '');
  const product = (id: string) => l.products.find((p) => p.id === id);
  const items = (lines: Pick<OrderLine, 'product_id' | 'size_id' | 'qty'>[], withSize = false) =>
    lines
      .map((x) => {
        const p = product(x.product_id);
        const s = l.sizes.find((z) => z.id === x.size_id);
        return `${p ? productName(p, locale) : x.product_id}${withSize && s ? ` ${sizeLabel(s, locale)}` : ''} ×${x.qty}`;
      })
      .join(', ');
  const reason = (code: string, note?: string | null) =>
    REASONS.includes(code) ? `“${t(`void.reason.${code}` as MessageKey)}${note ? `, ${note}` : ''}”` : `“${note ?? code}”`;
  const method = (p: Payment) => (p.method === 'cash' ? t('pay.cash') : `M-Pesa${p.mpesa_ref_last4 ? ` …${p.mpesa_ref_last4}` : ''}`);
  const none: AuditText['changes'] = [];

  switch (e.kind) {
    case 'order_recorded': {
      const o: Order = d.order;
      const lines: OrderLine[] = d.lines ?? [];
      const paid: Payment[] = d.payments ?? [];
      const total = lines.reduce((s, x) => s + lineTotal(x), 0);
      const shown = order(o.id) ?? o;
      return {
        what: [
          t('admin.audit.orderRecorded', { order: orderName(shown) }),
          formatKES(total),
          t('admin.audit.server', { name: person(o.server_id) }),
          paid.length ? t('admin.audit.paidBy', { method: paid.map(method).join(' + ') }) : null,
        ].filter(Boolean).join(' · '),
        changes: none,
      };
    }
    case 'lines_added': {
      const lines: OrderLine[] = d.lines ?? [];
      return { what: t('admin.audit.linesAdded', { order: orderName(order(d.order_id)), items: items(lines), amount: formatKES(lines.reduce((s, x) => s + lineTotal(x), 0)) }), changes: none };
    }
    case 'lines_moved':
      return { what: t('admin.audit.linesMoved', { from: orderName(order(d.from_order_id)), to: orderName(order(d.order?.id) ?? d.order) }), changes: none };
    case 'payment_recorded': {
      const paid: Payment[] = d.payments ?? [];
      return { what: t('admin.audit.payment', { order: orderName(order(d.order_id)), method: paid.map(method).join(' + '), amount: formatKES(paid.reduce((s, p) => s + p.amount_kes, 0)) }), changes: none };
    }
    case 'void_recorded': {
      const o = order(d.order_id);
      return { what: t('admin.audit.selfVoid', { order: o?.short_no ?? '', count: (d.parts ?? []).reduce((n: number, p: { qty: number }) => n + p.qty, 0), reason: reason(d.reason) }), changes: none };
    }
    case 'void_requested': {
      const a: ApprovalItem = l.approvals.find((x) => x.id === d.approval?.id) ?? d.approval;
      const o = order(a?.target.order_id);
      const what = a?.target.item ? items([a.target.item], true) : a?.target.whole_order ? t('admin.wholeOrder') : items(a?.target.line_ids.map((id) => l.lines.find((x) => x.id === id)).filter((x) => x !== undefined) ?? []);
      const key = a?.kind === 'write_off' ? 'admin.audit.writeOffReported' : a?.kind === 'comp' ? 'admin.audit.compRequested' : 'admin.audit.voidRequested';
      return { what: [t(key), [o?.short_no, what].filter(Boolean).join(' '), a ? reason(a.reason_code, a.note) : null].filter(Boolean).join(' · '), changes: none };
    }
    case 'approval_decided':
    case 'approval_undone': {
      const a = l.approvals.find((x) => x.id === d.approval_id);
      const o = order(a?.target.order_id);
      const kind = a ? t(({ void: 'approvals.kind.void', write_off: 'approvals.kind.writeOff', comp: 'approvals.kind.comp', price_mismatch: 'approvals.kind.priceMismatch', archived_product: 'admin.kind.archived', revoked_device: 'admin.kind.revoked' } as const)[a.kind]) : '';
      const subject = [kind, o?.short_no, a ? formatKES(a.amount_kes) : null].filter(Boolean).join(' · ');
      if (e.kind === 'approval_undone') return { what: t('admin.audit.undone', { what: subject }), changes: none };
      return {
        what: t(d.decision === 'approved' ? 'admin.audit.approved' : 'admin.audit.rejected', { what: subject }),
        changes: [{ before: t('admin.audit.waiting'), after: t(d.decision === 'approved' ? 'admin.decided.approved' : 'admin.decided.rejected') }],
      };
    }
    case 'product_saved': {
      const p: Product = d.product;
      const before: { product: Product; sizes: ProductSize[] } | null = d.before;
      if (!before) return { what: t('admin.audit.productAdded', { name: p.name }), changes: none };
      const changes: AuditText['changes'] = [];
      if (before.product.name !== p.name) changes.push({ label: t('product.name'), before: before.product.name, after: p.name });
      if (!!before.product.archived_at !== !!p.archived_at) changes.push({ before: before.product.archived_at ? t('admin.product.archived') : t('admin.audit.onSale'), after: p.archived_at ? t('admin.product.archived') : t('admin.audit.onSale') });
      if (before.product.manual_out_of_stock !== p.manual_out_of_stock) changes.push({ before: before.product.manual_out_of_stock ? t('status.outOfStock') : t('product.oosOff'), after: p.manual_out_of_stock ? t('status.outOfStock') : t('product.oosOff') });
      if (before.product.stock_mode !== p.stock_mode) changes.push({ label: t('product.stockMode'), before: t(before.product.stock_mode === 'ml' ? 'product.modeMl' : 'product.modeCount'), after: t(p.stock_mode === 'ml' ? 'product.modeMl' : 'product.modeCount') });
      for (const s of (d.sizes ?? []) as ProductSize[]) {
        const old = before.sizes.find((x) => x.id === s.id);
        if (!old) changes.push({ label: s.label_en, before: '—', after: formatKES(s.price_kes) });
        else {
          if (old.price_kes !== s.price_kes) changes.push({ label: s.label_en, before: formatKES(old.price_kes), after: formatKES(s.price_kes) });
          if (old.enabled !== s.enabled) changes.push({ label: s.label_en, before: old.enabled ? t('admin.on') : t('admin.off'), after: s.enabled ? t('admin.on') : t('admin.off') });
          if (old.deduct !== s.deduct) changes.push({ label: s.label_en, before: String(old.deduct), after: String(s.deduct) });
        }
      }
      const priceOnly = changes.length > 0 && changes.every((c) => c.before.startsWith('KES') && c.after.startsWith('KES'));
      return { what: t(priceOnly ? 'admin.audit.priceChanged' : 'admin.audit.productChanged', { name: p.name }), changes };
    }
    case 'delivery_recorded': {
      const del: Delivery = d.delivery;
      const count = del.lines.length + del.keg_ids.length;
      return { what: [t('admin.audit.stockAdded'), del.note_no, del.supplier, t('admin.audit.lines', { count })].filter(Boolean).join(' · '), changes: none };
    }
    case 'shelf_counted': {
      const p = product(d.product_id);
      const unit = p?.stock_mode === 'ml' ? 'ml' : t('admin.unit.bottles');
      const n = (x: number) => `${x < 0 ? '−' : ''}${formatAmount(Math.abs(x))} ${unit}`;
      return { what: t('admin.audit.shelfCounted', { name: p ? productName(p, locale) : d.product_id }), changes: [{ before: n(d.before_qty), after: n(d.counted_qty) }] };
    }
    case 'keg_finished': {
      const code = (id: string) => l.kegs.find((k) => k.id === id)?.code ?? id;
      return { what: [t('admin.audit.kegFinished', { code: code(d.keg_id) }), d.next_keg_id ? t('admin.audit.kegNext', { code: code(d.next_keg_id) }) : null].filter(Boolean).join(' · '), changes: none };
    }
    case 'keg_checked': {
      const code = l.kegs.find((k) => k.id === d.keg_id)?.code ?? d.keg_id;
      return { what: d.write_off_cups ? t('admin.audit.kegWrittenOff', { code, count: d.write_off_cups, amount: formatKES(d.value_kes) }) : t('admin.audit.kegChecked', { code }), changes: none };
    }
    case 'login':
    case 'logged_in':
      return { what: t('admin.audit.loggedIn'), changes: none };
    case 'pin_failed':
      return { what: d.pin_locked_until ? t('admin.audit.pinLocked', { count: d.failed_pin_attempts }) : t('admin.audit.pinWrong', { count: d.failed_pin_attempts }), changes: none };
    case 'person_unlocked':
      return { what: t('admin.audit.unlocked', { name: person(d.person_id) }), changes: none };
    case 'pin_reset':
      return { what: t('admin.audit.pinReset', { name: person(d.person_id) }), changes: none };
    case 'pin_set':
      return { what: t('admin.audit.pinSet'), changes: none };
    case 'person_saved':
      return { what: t('admin.audit.personAdded', { name: d.person?.name ?? '', role: t(`staff.role.${d.person?.role ?? 'server'}` as MessageKey) }), changes: none };
    case 'person_archived':
      return { what: t('admin.audit.personArchived', { name: person(d.person_id) }), changes: none };
    case 'device_paired':
      return { what: t('admin.audit.devicePaired', { name: l.devices.find((x) => x.id === e.ref_id)?.name ?? e.ref_id ?? '' }), changes: none };
    case 'device_revoked':
      return { what: t('admin.audit.deviceRevoked', { name: l.devices.find((x) => x.id === d.device_id)?.name ?? d.device_id, reason: d.reason }), changes: none };
    case 'shift_opened': {
      const s: Shift = d.shift;
      return { what: t('admin.audit.shiftOpened', { amount: formatKES(s.float_kes) }), changes: none };
    }
    case 'shift_closed': {
      const result: number = d.result_kes ?? 0;
      const counted: number = d.counted_cash_kes ?? 0;
      const expected: number = d.expected_cash_kes ?? counted - result;
      const outcome = result === 0 ? t('status.matches') : t(result < 0 ? 'admin.shortAmount' : 'admin.overAmount', { amount: formatKES(Math.abs(result)) });
      return {
        what: t('admin.audit.shiftClosed', { result: outcome }),
        changes: [{ before: t('admin.audit.expected', { amount: formatKES(expected) }), after: t('admin.audit.counted', { amount: formatKES(counted) }) }],
      };
    }
    case 'order_handed_over':
      return { what: t('admin.audit.handedOver', { order: orderName(order(d.order_id)) }), changes: none };
    case 'handover_accepted':
      return { what: t('admin.audit.handoverAccepted', { count: (d.order_ids ?? []).length }), changes: none };
    case 'day_closed': {
      const c = d.day_close;
      return { what: t('admin.audit.dayClosed', { till: formatKES(c.till_total_kes), recorded: formatKES(c.recorded_mpesa_kes) }), changes: none };
    }
    default:
      return { what: e.kind.replace(/_/g, ' '), changes: none };
  }
}
