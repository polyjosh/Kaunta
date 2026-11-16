import { liveQuery } from 'dexie';
import { useEffect } from 'react';
import type { AuditEvent, Id } from '../domain/types';
import type { KauntaDB } from './db';
import type { OutboxEntry } from './events';

/**
 * Demo only (no server): for a bar the owner added, the counter and admin
 * share one browser store, and this stands in for the server. Each change
 * the counter queues is marked sent, its order number becomes final, and it
 * gets the audit row the server would write (so it shows in admin's Sales
 * feed and Audit log). Nothing is decided here that the counter did not
 * already apply locally; price checks and approvals happen as on the phone.
 */
export async function acceptQueued(db: KauntaDB, now: () => Date = () => new Date()): Promise<number> {
  return db.transaction('rw', [db.outbox, db.auditEvents, db.orders, db.devices, db.meta], async () => {
    const pending = (await db.outbox.where('status').equals('pending').toArray()) as OutboxEntry[];
    if (pending.length === 0) return 0;
    const at = now().toISOString();
    const devices = new Set<Id>();
    for (const e of pending) {
      const p = e.payload as Record<string, unknown> & { order?: { id?: string }; shift?: { id?: string } };
      const audit: AuditEvent = {
        id: e.id,
        at: e.created_at,
        actor_id: e.recorded_by,
        device_id: e.device_id,
        kind: e.type,
        // The same reference the server's ingest_event() keeps.
        ref_id: (p.order_id as string) ?? p.order?.id ?? (p.person_id as string) ?? p.shift?.id ?? (p.shift_id as string) ?? null,
        detail: p,
        synced_at: at,
      };
      await db.auditEvents.put(audit);
      if (p.order?.id) await db.orders.update(p.order.id, { short_no_provisional: false, synced_at: at });
      await db.outbox.where('id').equals(e.id).modify({ status: 'sent', synced_at: at });
      devices.add(e.device_id);
    }
    for (const id of devices) await db.devices.update(id, { last_sync_at: at });
    await db.meta.put({ key: 'last_sync_at', value: at });
    return pending.length;
  });
}

/** Accepts the counter's changes as they are queued, until stopped. */
export function runDemoServer(db: KauntaDB): () => void {
  let busy = false;
  const sub = liveQuery(() => db.outbox.where('status').equals('pending').count()).subscribe({
    next: (n) => {
      if (n === 0 || busy) return;
      busy = true;
      void acceptQueued(db).finally(() => {
        busy = false;
      });
    },
  });
  return () => sub.unsubscribe();
}

/** Runs the stand-in server for this store while mounted (demo bars the owner added). */
export function useDemoServer(db: KauntaDB | null, enabled: boolean): void {
  useEffect(() => (db && enabled ? runDemoServer(db) : undefined), [db, enabled]);
}
