import { uuidv7 } from '../domain/ids';
import { lineTotal, orderTotal, paidTotal } from '../domain/orders';
import { selfVoidMsLeft, voidRoute } from '../domain/voids';
import type { VoidRoute } from '../domain/voids';
import type { Id, VoidReason } from '../domain/types';
import type { KauntaDB } from './db';
import type { VoidPart } from './events';
import { nowOf, recordEvent } from './outbox';
import type { RecordContext } from './outbox';

export interface VoidRequest {
  order_id: Id;
  /** Units to void, per line. Ignored when `whole_order` is set. */
  items: { line_id: Id; qty: number }[];
  whole_order: boolean;
  reason: VoidReason;
}

export interface VoidOutcome extends VoidRoute {
  amount_kes: number;
}

/**
 * R-VOID-1…3. Decides, at the moment of pressing the button, whether this
 * person may void by themselves or whether it goes to an admin, and records
 * exactly one event either way. The decision is made here, not on the
 * screen, so a window that shut a second ago cannot be slipped through.
 */
export async function voidLines(db: KauntaDB, ctx: RecordContext, request: VoidRequest): Promise<VoidOutcome> {
  const at = nowOf(ctx);
  return db.transaction('rw', db.tables, async () => {
    const [order, bar, lines, payments] = await Promise.all([
      db.orders.get(request.order_id),
      db.bar.toCollection().first(),
      db.lines.where('order_id').equals(request.order_id).toArray(),
      db.payments.where('order_id').equals(request.order_id).toArray(),
    ]);
    if (!order || !bar) throw new Error(`No such order: ${request.order_id}`);
    if (order.status === 'voided') throw new Error(`Order ${order.short_no} is already voided`);

    const active = lines.filter((line) => line.status === 'active');
    const wanted = request.whole_order ? active.map((line) => ({ line_id: line.id, qty: line.qty })) : request.items;
    if (wanted.length === 0) throw new RangeError('Nothing to void');

    const parts: VoidPart[] = [];
    const targets = wanted.map((item) => {
      const line = active.find((l) => l.id === item.line_id);
      if (!line) throw new Error(`That item cannot be voided: ${item.line_id}`);
      if (!Number.isSafeInteger(item.qty) || item.qty <= 0 || item.qty > line.qty) {
        throw new RangeError(`Cannot void ${item.qty} of ${line.qty}`);
      }
      const partial = item.qty < line.qty;
      parts.push({ line_id: line.id, qty: item.qty, split_line_id: partial ? uuidv7(at.getTime()) : null });
      return { ...line, qty: item.qty };
    });

    const amount_kes = targets.reduce((sum, line) => sum + lineTotal(line), 0);
    // Voiding below what was already paid means money has to go back: an admin's call.
    const moneyAtStake = paidTotal(payments) > orderTotal(lines) - amount_kes;
    const msLeft = selfVoidMsLeft(targets, ctx.person_id, at, bar.self_void_minutes);
    const decision = voidRoute(request.reason, msLeft, moneyAtStake);

    if (decision.route === 'self') {
      await recordEvent(db, ctx, {
        type: 'void_recorded',
        payload: { order_id: order.id, parts, reason: request.reason, voided_at: at.toISOString() },
      });
    } else {
      await recordEvent(db, ctx, {
        type: 'void_requested',
        payload: {
          order_id: order.id,
          parts,
          approval: {
            id: uuidv7(at.getTime()),
            kind: decision.kind,
            target: {
              order_id: order.id,
              line_ids: parts.map((part) => part.split_line_id ?? part.line_id),
              whole_order: request.whole_order,
            },
            amount_kes,
            reason_code: request.reason,
            requested_by: ctx.person_id,
            device_id: ctx.device_id,
            requested_at: at.toISOString(),
            status: 'waiting',
            decided_by: null,
            decided_at: null,
          },
        },
      });
    }
    return { ...decision, amount_kes };
  });
}
