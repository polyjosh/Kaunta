import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { StatusChip } from '../components/StatusChip';
import { moveToNewOrder, recordPayment } from '../data/commands';
import type { PaymentPart } from '../data/commands';
import { useConnection, useDb, useQuery } from '../data/react';
import { lineTotal, orderDue, orderTotal, paidTotal, paymentState } from '../domain/orders';
import { evenShare } from '../domain/payments';
import { localTime, minutesBetween } from '../domain/time';
import type { Id, OrderLine } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import { formatAmount, formatKES } from '../lib/money';
import { displayLabel, productName, sizeLabel } from './labels';
import { useSession } from './Session';
import { Avatar, BackBar, NumberPad, Sheet, Toast, toastFromState, useNow, withOffline } from './ui';
import type { ToastMessage } from './ui';

type Method = 'cash' | 'mpesa' | 'split';
type SheetState =
  | { kind: 'pay'; part?: number }
  | { kind: 'split' }
  | { kind: 'line'; lineId: Id }
  | { kind: 'move'; lineId?: Id }
  | null;

/** Screen 4: one order, what is still to pay, and confirming payment. Rules R-ORD-2…5. */
export function OrderDetailScreen() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const db = useDb();
  const session = useSession();
  const navigate = useNavigate();
  const now = useNow();
  const [sheet, setSheet] = useState<SheetState>(null);
  const location = useLocation();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const { online } = useConnection();
  const offlineAware = (message: ToastMessage) => withOffline(message, online, t);
  const closeSheet = useCallback(() => setSheet(null), []);
  const clearToast = useCallback(() => setToast(null), []);

  // Arriving from another screen (or from this one, for a moved-to order) may bring a toast.
  useEffect(() => {
    setSheet(null);
    const arrived = toastFromState(location.state);
    if (arrived) setToast(arrived);
  }, [location.key, location.state]);

  const data = useQuery(
    async (d) => {
      const order = await d.orders.get(id);
      if (!order) return null;
      const [lines, payments, people, products, sizes] = await Promise.all([
        d.lines.where('order_id').equals(id).sortBy('created_at'),
        d.payments.where('order_id').equals(id).sortBy('created_at'),
        d.people.toArray(),
        d.products.toArray(),
        d.sizes.toArray(),
      ]);
      return { order, lines, payments, people, products, sizes };
    },
    [id],
  );
  if (data === undefined) return null;
  if (data === null) {
    return (
      <div className="c-screen">
        <BackBar to="/counter/orders" title={t('orders.title')} />
        <main className="c-body c-empty">
          <strong>{t('orders.empty')}</strong>
        </main>
      </div>
    );
  }

  const { order, lines, payments } = data;
  const nameOf = (personId: Id) => data.people.find((p) => p.id === personId)?.name ?? '';
  const server = data.people.find((p) => p.id === order.server_id);
  const total = orderTotal(lines);
  const paid = paidTotal(payments);
  const due = orderDue(lines, payments);
  const state = paymentState(lines, payments);
  const label = displayLabel(order.label, t);
  const itemCount = lines.reduce((sum, l) => (l.status === 'voided' ? sum : sum + l.qty), 0);
  const methodName = (method: 'cash' | 'mpesa') => t(method === 'cash' ? 'pay.cash' : 'pay.mpesa');

  const confirm = async (parts: PaymentPart[], methodLabel: string) => {
    const received = parts.reduce((sum, p) => sum + p.amount_kes, 0);
    await recordPayment(db, session.recordContext(), order.id, parts);
    if (received >= due) {
      // Paid in full: the order leaves Open orders, and the toast follows the user there.
      navigate('/counter/orders', {
        replace: true,
        state: { toast: offlineAware({ text: t('pay.toastFull', { no: order.short_no, method: methodLabel }) }) },
      });
      return;
    }
    setSheet(null);
    setToast(
      offlineAware({
        text: t('pay.toastPart', { amount: formatKES(received), method: methodLabel, left: formatKES(due - received) }),
      }),
    );
  };

  const move = async (items: { line_id: Id; qty: number }[]) => {
    const created = await moveToNewOrder(db, session.recordContext(), order.id, items);
    navigate(`/counter/orders/${created.id}`, {
      state: { toast: offlineAware({ text: t('move.toast', { no: created.short_no }) }) },
    });
  };

  const describe = (line: OrderLine) => {
    const product = data.products.find((p) => p.id === line.product_id);
    const size = data.sizes.find((s) => s.id === line.size_id);
    return `${product ? productName(product, locale) : ''} ${size ? sizeLabel(size, locale) : ''}`.trim();
  };
  const open = order.status === 'open';
  const activeLines = lines.filter((l) => l.status === 'active');
  const menuLine = sheet?.kind === 'line' ? activeLines.find((l) => l.id === sheet.lineId) : undefined;

  return (
    <div className="c-screen">
      <BackBar
        to="/counter/orders"
        title={
          <span className="c-title-split">
            <span className="c-title-label">{label}</span> <span className="c-order-no">{order.short_no}</span>
          </span>
        }
        subtitle={t('order.openSince', { minutes: minutesBetween(order.created_at, now), time: localTime(order.created_at) })}
      />

      <main className="c-body c-order-detail">
        <div className="c-who-chips">
          <span className="c-who-chip">
            {server && <Avatar person={server} size={24} />}
            {t('sell.serverChip', { name: server?.name ?? '' })}
          </span>
          <span className="c-who-chip">{t('common.recordedBy', { name: nameOf(order.recorded_by) })}</span>
        </div>

        <section className="c-due-card">
          <div className="c-due-top">
            <span>{t('order.stillToPay')}</span>
            <strong>{formatKES(due)}</strong>
          </div>
          <div className="c-progress c-progress-lg">
            <span style={{ width: `${total > 0 ? Math.round((Math.min(paid, total) / total) * 100) : 0}%` }} />
          </div>
          <div className="c-due-bottom">
            <span>{t('orders.paidOf', { paid: formatKES(paid), total: formatAmount(total) })}</span>
            <StatusChip status={state} />
          </div>
        </section>

        <section>
          <h2 className="c-section-head">{t('order.items', { count: itemCount })}</h2>
          {lines.map((line) => {
            return (
              <div key={line.id} className={`c-detail-line${line.status === 'voided' ? ' is-voided' : ''}`}>
                <span className="c-detail-qty">{line.qty}×</span>
                <span className="c-detail-text">
                  <strong>{describe(line)}</strong>
                  <span>
                    {formatKES(line.unit_price_kes)}
                    {line.qty > 1 ? ` ${t('common.each')}` : ''} · {localTime(line.created_at)} {nameOf(line.recorded_by)}
                  </span>
                </span>
                {line.status === 'active' ? (
                  <span className="c-detail-sum">{formatKES(lineTotal(line))}</span>
                ) : (
                  // Waiting on an admin (still counts), or voided (does not).
                  <StatusChip status={line.status === 'voided' ? 'voided' : 'needsReview'} className="k-chip-sm" />
                )}
                {line.status === 'active' && open && (
                  <button
                    type="button"
                    className="c-line-menu"
                    aria-label={t('order.lineOptions', { name: describe(line) })}
                    onClick={() => setSheet({ kind: 'line', lineId: line.id })}
                  >
                    <Icon name="more" size={22} strokeWidth={3.4} />
                  </button>
                )}
              </div>
            );
          })}
          <div className="c-detail-total">
            <span>{t('order.orderTotal')}</span>
            <strong>{formatKES(total)}</strong>
          </div>
        </section>

        {payments.length > 0 && (
          <section className="c-payments">
            <h2 className="c-section-head">{t('order.payments')}</h2>
            {payments.map((p) => (
              <div key={p.id} className="c-payment-row">
                <Icon name="check-circle" size={22} />
                <span>
                  {methodName(p.method)}
                  {p.mpesa_ref_last4 ? ` ${p.mpesa_ref_last4}` : ''} · {localTime(p.created_at)} · {nameOf(p.recorded_by)}
                </span>
                <strong>{formatKES(p.amount_kes)}</strong>
              </div>
            ))}
          </section>
        )}

        {open && (
          <div className="c-order-actions">
            <button type="button" className="c-btn c-btn-secondary" onClick={() => navigate(`/counter/sell?order=${order.id}`)}>
              <Icon name="plus" size={20} strokeWidth={2.6} />
              {t('order.addItems')}
            </button>
            <button type="button" className="c-btn c-btn-secondary" disabled={due <= 0} onClick={() => setSheet({ kind: 'split' })}>
              {t('order.splitBill')}
            </button>
          </div>
        )}
        {open && activeLines.length > 0 && (
          <button type="button" className="c-btn c-btn-link c-void-link" onClick={() => navigate(`/counter/orders/${order.id}/void`)}>
            {t('order.voidLink')}
          </button>
        )}
      </main>

      {due > 0 && (
        <footer className="c-bottom">
          <button type="button" className="c-btn c-btn-primary" onClick={() => setSheet({ kind: 'pay' })}>
            {t('order.confirmPayment', { amount: formatKES(due) })}
          </button>
        </footer>
      )}

      <Toast message={toast} onDone={clearToast} />

      {sheet?.kind === 'pay' && (
        <Sheet
          title={t('pay.title')}
          subtitle={`${label} · ${order.short_no} · ${t('sell.serverChip', { name: server?.name ?? '' })}`}
          onClose={closeSheet}
        >
          <PaymentForm due={due} initialPart={sheet.part} methodName={methodName} onConfirm={confirm} />
        </Sheet>
      )}

      {sheet?.kind === 'split' && (
        <Sheet title={t('order.splitBill')} subtitle={`${label} · ${order.short_no}`} onClose={closeSheet}>
          <p className="c-sheet-lead">{t('split.evenly', { amount: formatKES(due) })}</p>
          <div className="c-split-grid">
            {[2, 3, 4].map((people) => {
              const share = evenShare(due, people);
              return (
                // Picking a split opens the payment sheet with one share filled in.
                <button key={people} type="button" className="c-split-btn" onClick={() => setSheet({ kind: 'pay', part: share })}>
                  <strong>{t('split.people', { count: people })}</strong>
                  <span>{t('split.each', { amount: formatKES(share) })}</span>
                </button>
              );
            })}
          </div>
          <p className="c-sheet-hint">{t('split.note')}</p>
          {/* Split by items = move lines to a new order (R-ORD-5). */}
          {itemCount > 1 && (
            <button type="button" className="c-btn c-btn-secondary" onClick={() => setSheet({ kind: 'move' })}>
              {t('split.byItems')}
            </button>
          )}
          <button type="button" className="c-btn c-btn-link" onClick={closeSheet}>
            {t('common.done')}
          </button>
        </Sheet>
      )}

      {menuLine && (
        <Sheet title={describe(menuLine)} subtitle={`${label} · ${order.short_no}`} onClose={closeSheet}>
          {itemCount > 1 && (
            <button type="button" className="c-btn c-btn-secondary" onClick={() => setSheet({ kind: 'move', lineId: menuLine.id })}>
              {t('order.moveToNew')}
            </button>
          )}
          <button
            type="button"
            className="c-btn c-btn-danger"
            onClick={() => navigate(`/counter/orders/${order.id}/void?line=${menuLine.id}`)}
          >
            {t('order.voidItem')}
          </button>
        </Sheet>
      )}

      {sheet?.kind === 'move' && (
        <Sheet title={t('order.moveToNew')} subtitle={`${label} · ${order.short_no}`} onClose={closeSheet}>
          <MoveForm
            lines={activeLines.map((line) => ({ line, name: describe(line) }))}
            stayingOther={itemCount - activeLines.reduce((sum, l) => sum + l.qty, 0)}
            total={total}
            paid={paid}
            preset={sheet.lineId}
            onMove={move}
          />
        </Sheet>
      )}
    </div>
  );
}

interface MoveFormProps {
  lines: { line: OrderLine; name: string }[];
  /** Units that cannot move (waiting on a void) but do stay on the order. */
  stayingOther: number;
  total: number;
  paid: number;
  preset?: Id;
  onMove: (items: { line_id: Id; qty: number }[]) => Promise<void>;
}

/** Split by items: pick how many of each line move to a new order. */
function MoveForm({ lines, stayingOther, total, paid, preset, onMove }: MoveFormProps) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<Record<Id, number>>(preset ? { [preset]: 1 } : {});
  const busy = useRef(false);

  const qtyOf = (id: Id) => picked[id] ?? 0;
  const set = (id: Id, qty: number) => setPicked((current) => ({ ...current, [id]: qty }));
  const moving = lines.reduce((sum, { line }) => sum + qtyOf(line.id), 0);
  const movingKes = lines.reduce((sum, { line }) => sum + qtyOf(line.id) * line.unit_price_kes, 0);
  const staying = lines.reduce((sum, { line }) => sum + line.qty - qtyOf(line.id), 0) + stayingOther;
  const paidOk = paid <= total - movingKes;
  const valid = moving > 0 && staying > 0 && paidOk;

  const submit = async () => {
    if (!valid || busy.current) return;
    busy.current = true;
    try {
      await onMove(lines.filter(({ line }) => qtyOf(line.id) > 0).map(({ line }) => ({ line_id: line.id, qty: qtyOf(line.id) })));
    } finally {
      busy.current = false;
    }
  };

  return (
    <>
      <p className="c-sheet-lead">{t('move.hint')}</p>
      <div className="c-rows">
        {lines.map(({ line, name }) => (
          <div key={line.id} className="c-line-row">
            <div className="c-line-text">
              <strong>{name}</strong>
              <span>
                {formatKES(line.unit_price_kes)} {t('common.each')} · {line.qty}×
              </span>
            </div>
            <button
              type="button"
              className="c-icon-btn"
              aria-label={`${t('sell.removeOne')}: ${name}`}
              disabled={qtyOf(line.id) === 0}
              onClick={() => set(line.id, qtyOf(line.id) - 1)}
            >
              <Icon name="minus" size={20} strokeWidth={2.6} />
            </button>
            <span className="c-line-qty">{qtyOf(line.id)}</span>
            <button
              type="button"
              className="c-icon-btn"
              aria-label={`${t('sell.addOne')}: ${name}`}
              disabled={qtyOf(line.id) >= line.qty}
              onClick={() => set(line.id, qtyOf(line.id) + 1)}
            >
              <Icon name="plus" size={20} strokeWidth={2.6} />
            </button>
          </div>
        ))}
      </div>
      {moving > 0 && staying === 0 && <p className="c-move-note">{t('move.keepOne')}</p>}
      {moving > 0 && !paidOk && <p className="c-move-note">{t('move.paidTooMuch', { paid: formatKES(paid) })}</p>}
      <button type="button" className="c-btn c-btn-primary" disabled={!valid} onClick={() => void submit()}>
        {t('move.button', { count: moving })}
      </button>
    </>
  );
}

interface PaymentFormProps {
  due: number;
  /** A share from "Split bill": starts on "Part of it" with this amount. */
  initialPart?: number;
  methodName: (method: 'cash' | 'mpesa') => string;
  onConfirm: (parts: PaymentPart[], methodLabel: string) => Promise<void>;
}

/** Amount (all / part) · method (cash / M-Pesa / split) · optional M-Pesa last 4. */
function PaymentForm({ due, initialPart, methodName, onConfirm }: PaymentFormProps) {
  const { t } = useI18n();
  const [amount, setAmount] = useState<'full' | 'part'>(initialPart ? 'part' : 'full');
  const [part, setPart] = useState(initialPart ?? 0);
  const [method, setMethod] = useState<Method>('mpesa');
  const [cash, setCash] = useState(0);
  const [code, setCode] = useState('');
  // Which amount the keypad is editing.
  const [editing, setEditing] = useState<'part' | 'cash'>('part');
  const busy = useRef(false);

  const received = amount === 'full' ? due : part;
  const mpesaShare = received - cash;
  const codeOk = code === '' || /^[A-Z0-9]{4}$/.test(code);
  const valid =
    received > 0 && received <= due && codeOk && (method !== 'split' || (cash > 0 && mpesaShare > 0));
  const showPad = (amount === 'part' && editing === 'part') || (method === 'split' && editing === 'cash');

  const submit = async () => {
    if (!valid || busy.current) return;
    busy.current = true;
    try {
      const ref = code || null;
      if (method === 'split') {
        await onConfirm(
          [
            { method: 'cash', amount_kes: cash },
            { method: 'mpesa', amount_kes: mpesaShare, mpesa_ref_last4: ref },
          ],
          t('pay.cashPlusMpesa', { cash: methodName('cash').toLowerCase(), mpesa: methodName('mpesa') }),
        );
      } else {
        await onConfirm(
          [{ method, amount_kes: received, mpesa_ref_last4: method === 'mpesa' ? ref : null }],
          method === 'cash' ? methodName('cash').toLowerCase() : methodName('mpesa'),
        );
      }
    } finally {
      busy.current = false;
    }
  };

  return (
    <>
      <div className="c-field">
        <span className="c-field-label">{t('pay.amountReceived')}</span>
        <div className="c-choice-grid c-choice-2">
          <button type="button" className="c-choice" aria-pressed={amount === 'full'} onClick={() => setAmount('full')}>
            <span>{t('pay.allOfIt')}</span>
            <strong>{formatKES(due)}</strong>
          </button>
          <button
            type="button"
            className={`c-choice${amount === 'part' && editing === 'part' ? ' is-editing' : ''}`}
            aria-pressed={amount === 'part'}
            onClick={() => {
              setAmount('part');
              setEditing('part');
            }}
          >
            <span>{t('pay.partOfIt')}</span>
            <strong>{formatKES(part)}</strong>
          </button>
        </div>
      </div>

      <div className="c-field">
        <span className="c-field-label" id="pay-how">
          {t('pay.how')}
        </span>
        <div className="c-choice-grid c-choice-3" role="radiogroup" aria-labelledby="pay-how">
          {(['cash', 'mpesa', 'split'] as Method[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              className="c-choice c-choice-method"
              onClick={() => {
                setMethod(m);
                if (m === 'split') setEditing('cash');
                else if (amount === 'part') setEditing('part');
              }}
            >
              {m === 'split' ? t('pay.split') : methodName(m)}
            </button>
          ))}
        </div>
      </div>

      {method === 'split' && (
        <div className="c-field">
          <button
            type="button"
            className={`c-split-row${editing === 'cash' ? ' is-editing' : ''}`}
            onClick={() => setEditing('cash')}
          >
            <span>{methodName('cash')}</span>
            <strong>{formatKES(cash)}</strong>
          </button>
          <div className="c-split-row">
            <span>{methodName('mpesa')}</span>
            <strong>{formatKES(Math.max(0, mpesaShare))}</strong>
          </div>
          <span className="c-field-hint">{t('pay.splitHint')}</span>
        </div>
      )}

      {showPad && (
        <NumberPad
          value={editing === 'cash' ? cash : part}
          onChange={(value) => (editing === 'cash' ? setCash(Math.min(value, received)) : setPart(Math.min(value, due)))}
        />
      )}

      {method !== 'cash' && (
        <label className="c-field">
          <span className="c-field-label">
            {t('pay.mpesaLast4')} <span className="c-optional">({t('common.optional')})</span>
          </span>
          <input
            className="c-code-input"
            type="text"
            inputMode="text"
            maxLength={4}
            autoCapitalize="characters"
            autoComplete="off"
            value={code}
            aria-invalid={!codeOk}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
            placeholder={t('pay.mpesaExample')}
          />
          <span className="c-field-hint">{t('pay.mpesaHint')}</span>
        </label>
      )}

      <button type="button" className="c-btn c-btn-primary" disabled={!valid} onClick={() => void submit()}>
        {t('pay.confirm', { amount: formatKES(received) })}
      </button>
    </>
  );
}
