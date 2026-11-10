import type { KauntaDB } from '../data/db';
import type { OutboxEntry } from '../data/events';
import type { Instant } from '../domain/types';
import { PULL_TABLES } from './transport';
import type { PullData, PushResult, Row } from './transport';

/**
 * Postgres sends instants as "2026-11-10T19:20:00+00:00"; the app compares
 * ISO strings like "2026-11-10T19:20:00.000Z". Rewrite every *_at / *_until
 * field to that one form so string comparisons stay correct.
 */
export function normaliseRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      typeof value === 'string' && (key.endsWith('_at') || key.endsWith('_until')) && !Number.isNaN(Date.parse(value))
        ? new Date(value).toISOString()
        : value;
  }
  return out;
}

/** Records what the server said about each sent event, in one transaction. */
export async function applyPushResults(
  db: KauntaDB,
  batch: readonly OutboxEntry[],
  results: readonly PushResult[],
  serverTime: Instant,
): Promise<void> {
  const byId = new Map(results.map((r) => [r.id, r]));
  const missing = batch.filter((entry) => !byId.has(entry.id));
  // The server answers for every event or the batch is resent (it is idempotent).
  if (missing.length > 0) throw new Error(`server did not answer for ${missing.length} events`);

  const syncedAt = new Date(serverTime).toISOString();
  await db.transaction('rw', db.outbox, db.orders, async () => {
    for (const entry of batch) {
      const result = byId.get(entry.id)!;
      await db.outbox.where('id').equals(entry.id).modify(
        result.status === 'applied'
          ? { status: 'sent', synced_at: syncedAt }
          : { status: 'needs_review', synced_at: syncedAt, review_reason: result.reason, review_detail: result.detail },
      );
      // R-DAY-2: the server's final order number replaces the provisional one.
      const fix = result.result;
      if (fix?.order_id && fix.short_no) {
        await db.orders.update(fix.order_id, { short_no: fix.short_no, short_no_provisional: false });
      }
    }
  });
}

/**
 * Writes what the server sent, but only if nothing on this phone is still
 * waiting to be sent: server rows must never overwrite a change the server has
 * not seen yet. Returns false (and writes nothing) when it had to hold back.
 */
export async function applyPull(db: KauntaDB, data: PullData): Promise<boolean> {
  return db.transaction('rw', db.tables, async () => {
    if ((await db.outbox.where('status').equals('pending').count()) > 0) return false;
    for (const table of PULL_TABLES) {
      const rows = data[table] ?? [];
      if (rows.length > 0) await db.table(table).bulkPut(rows.map(normaliseRow));
    }
    await db.meta.bulkPut([
      { key: 'pull_cursor', value: new Date(data.cursor).toISOString() },
      { key: 'last_sync_at', value: new Date(data.server_time).toISOString() },
    ]);
    return true;
  });
}

/** Pairing: this phone's sample or old data goes; the server's arrives with the first pull. */
export async function resetForPairing(db: KauntaDB, deviceId: string, token: string): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear();
    await db.meta.bulkPut([
      { key: 'device_id', value: deviceId },
      { key: 'device_token', value: token },
    ]);
  });
}
