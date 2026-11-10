import { uuidv7 } from '../domain/ids';
import type { Id, Instant } from '../domain/types';
import type { KauntaDB } from './db';
import { applyEvent } from './events';
import type { KauntaEvent, OutboxEntry } from './events';

/** Who is recording, on which phone, and that phone's clock. */
export interface RecordContext {
  person_id: Id;
  device_id: Id;
  now?: () => Date;
}

export const nowOf = (ctx: RecordContext): Date => ctx.now?.() ?? new Date();

/**
 * R-SYNC-1: the only way a counter writes. In one transaction the event is
 * applied to the local store and appended to the outbox, so it is on screen
 * immediately and cannot be lost or half-saved if the phone dies.
 */
export async function recordEvent(db: KauntaDB, ctx: RecordContext, event: KauntaEvent): Promise<OutboxEntry> {
  const at = nowOf(ctx);
  const entry: OutboxEntry = {
    ...event,
    id: uuidv7(at.getTime()),
    recorded_by: ctx.person_id,
    device_id: ctx.device_id,
    created_at: at.toISOString(),
    status: 'pending',
    synced_at: null,
    attempts: 0,
    review_reason: null,
  };
  await db.transaction('rw', db.tables, async () => {
    await applyEvent(db, event);
    entry.seq = await db.outbox.add(entry);
  });
  return entry;
}

/** R-SYNC-2: what still has to be sent, in the order it happened. */
export function pendingEvents(db: KauntaDB): Promise<OutboxEntry[]> {
  return db.outbox.where('status').equals('pending').sortBy('seq');
}

/** The server accepted these events. */
export async function markSent(db: KauntaDB, eventIds: readonly Id[], syncedAt: Instant): Promise<void> {
  await db.outbox.where('id').anyOf(eventIds).modify({ status: 'sent', synced_at: syncedAt });
}

/** The server kept the event but an admin must decide something about it (R-SYNC-3). Never an error for staff. */
export async function markNeedsReview(
  db: KauntaDB,
  eventId: Id,
  reason: string,
  syncedAt: Instant,
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  await db.outbox
    .where('id')
    .equals(eventId)
    .modify({ status: 'needs_review', review_reason: reason, review_detail: detail, synced_at: syncedAt });
}

export async function noteAttempt(db: KauntaDB, eventIds: readonly Id[]): Promise<void> {
  await db.outbox.where('id').anyOf(eventIds).modify((entry) => {
    entry.attempts += 1;
  });
}

/** Feeds the sync pill (see lib/sync.ts). */
export async function outboxCounts(db: KauntaDB): Promise<{ queued: number; needsAdmin: number }> {
  const [queued, needsAdmin] = await Promise.all([
    db.outbox.where('status').equals('pending').count(),
    db.outbox.where('status').equals('needs_review').count(),
  ]);
  return { queued, needsAdmin };
}
