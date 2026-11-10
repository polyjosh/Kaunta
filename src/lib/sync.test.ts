import { describe, expect, it } from 'vitest';
import { syncPillStatus } from './sync';

const base = { online: true, queued: 0, sending: 0, needsAdmin: 0 };

describe('syncPillStatus (R-SYNC-2)', () => {
  it('is Synced when online with an empty queue', () => {
    expect(syncPillStatus(base)).toEqual({ state: 'synced', count: 0 });
  });

  it('is N waiting when online with a queue', () => {
    expect(syncPillStatus({ ...base, queued: 3 })).toEqual({ state: 'waiting', count: 3 });
  });

  it('is Sending N while a batch is in flight', () => {
    expect(syncPillStatus({ ...base, queued: 5, sending: 3 })).toEqual({ state: 'sending', count: 3 });
  });

  it('is Offline · N saved with no network', () => {
    expect(syncPillStatus({ ...base, online: false, queued: 3 })).toEqual({ state: 'offline', count: 3 });
    expect(syncPillStatus({ ...base, online: false })).toEqual({ state: 'offline', count: 0 });
  });

  it('is N needs admin when the server flagged something', () => {
    expect(syncPillStatus({ ...base, queued: 2, needsAdmin: 1 })).toEqual({ state: 'needsAdmin', count: 1 });
  });

  it('stays Offline when offline with items needing review, as in SyncOffline.dc.html', () => {
    expect(syncPillStatus({ online: false, queued: 3, sending: 0, needsAdmin: 1 })).toEqual({
      state: 'offline',
      count: 3,
    });
  });
});
