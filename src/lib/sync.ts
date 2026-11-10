export type SyncState = 'synced' | 'waiting' | 'sending' | 'offline' | 'needsAdmin';

export interface SyncSnapshot {
  online: boolean;
  /** Events in the outbox not yet accepted by the server. */
  queued: number;
  /** Events in the request currently in flight. */
  sending: number;
  /** Events the server flagged for an admin to decide. */
  needsAdmin: number;
}

export interface SyncPillStatus {
  state: SyncState;
  count: number;
}

/**
 * R-SYNC-2: which pill to show. Offline wins (calm grey, selling continues),
 * then anything an admin must review (yellow), then normal queue progress.
 * No state is ever an error.
 */
export function syncPillStatus({ online, queued, sending, needsAdmin }: SyncSnapshot): SyncPillStatus {
  if (!online) return { state: 'offline', count: queued };
  if (needsAdmin > 0) return { state: 'needsAdmin', count: needsAdmin };
  if (sending > 0) return { state: 'sending', count: sending };
  if (queued > 0) return { state: 'waiting', count: queued };
  return { state: 'synced', count: 0 };
}
