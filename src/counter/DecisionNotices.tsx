import { useState } from 'react';
import { Icon } from '../components/Icon';
import { useQuery } from '../data/react';
import type { ApprovalItem, Id } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import { formatKES } from '../lib/money';
import { productName, sizeLabel } from './labels';

const SEEN_KEY = 'kaunta.seenDecisions';
const RECENT_MS = 2 * 24 * 3_600_000;

function loadSeen(): Set<Id> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as Id[]) : []);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<Id>): void {
  try {
    // Only the latest few hundred: decisions older than two days are not shown anyway.
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-300)));
  } catch {
    // Without storage the notice simply shows again next time.
  }
}

/**
 * Tells whoever is at the counter that an admin or manager rejected one of
 * their requests (a void, a breakage report, an expense), until they tap OK.
 * Comes with the next sync, or at once on the same browser.
 */
export function DecisionNotices({ personId }: { personId: Id }) {
  const { t, locale } = useI18n();
  const [seen, setSeen] = useState(loadSeen);
  const data = useQuery(
    async (d) => {
      const since = Date.now() - RECENT_MS;
      const rejected = await d.approvals
        .where('status')
        .equals('rejected')
        .filter((a) => a.requested_by === personId && ['void', 'write_off', 'expense'].includes(a.kind) && !!a.decided_at && Date.parse(a.decided_at) >= since)
        .toArray();
      if (rejected.length === 0) return { rejected, lines: [], orders: [], people: [], products: [], sizes: [] };
      const [lines, orders, people, products, sizes] = await Promise.all([
        d.lines.where('id').anyOf(rejected.flatMap((a) => a.target.line_ids)).toArray(),
        d.orders.where('id').anyOf(rejected.map((a) => a.target.order_id).filter((x): x is Id => !!x)).toArray(),
        d.people.toArray(),
        d.products.toArray(),
        d.sizes.toArray(),
      ]);
      return { rejected, lines, orders, people, products, sizes };
    },
    [personId],
  );
  const shown = (data?.rejected ?? []).filter((a) => !seen.has(a.id)).sort((a, b) => a.decided_at!.localeCompare(b.decided_at!));
  if (!data || shown.length === 0) return null;

  const items = (a: ApprovalItem) => {
    const parts = a.target.item
      ? [{ product_id: a.target.item.product_id, size_id: a.target.item.size_id, qty: a.target.item.qty }]
      : data.lines.filter((l) => a.target.line_ids.includes(l.id));
    return parts
      .map((p) => {
        const product = data.products.find((x) => x.id === p.product_id);
        const size = data.sizes.find((x) => x.id === p.size_id);
        return `${product ? productName(product, locale) : ''} ${size ? sizeLabel(size, locale) : ''}`.trim() + ` ×${p.qty}`;
      })
      .join(', ');
  };
  const text = (a: ApprovalItem) => {
    const name = data.people.find((p) => p.id === a.decided_by)?.name ?? '';
    if (a.kind === 'expense') {
      return t('notice.expenseRejected', { label: String((a.detail as { label?: string } | null)?.label ?? ''), amount: formatKES(a.amount_kes), name });
    }
    if (a.kind === 'write_off') return t('notice.writeOffRejected', { items: items(a), name });
    const order = data.orders.find((o) => o.id === a.target.order_id);
    return t('notice.voidRejected', { order: order?.short_no ?? '', items: items(a), name });
  };
  const dismiss = (id: Id) => {
    const next = new Set(seen).add(id);
    saveSeen(next);
    setSeen(next);
  };

  return (
    <section className="c-notices" aria-label={t('notice.title')}>
      {shown.map((a) => (
        <div key={a.id} className="c-banner k-tone-error c-notice" role="alert">
          <Icon name="alert-triangle" size={24} />
          <p>{text(a)}</p>
          <button type="button" className="c-btn c-btn-secondary c-notice-ok" onClick={() => dismiss(a.id)}>
            {t('notice.ok')}
          </button>
        </div>
      ))}
    </section>
  );
}
