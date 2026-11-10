import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { outboxCounts } from '../data/outbox';
import { useConnection, useDb, useQuery } from '../data/react';
import { syncPillStatus } from '../lib/sync';
import type { SyncPillStatus } from '../lib/sync';
import type { ServerConfig } from './config';
import { SyncEngine } from './engine';
import type { EngineState } from './engine';
import { SupabaseTransport } from './transport';
import type { SyncTransport } from './transport';

interface SyncValue {
  /** The server, if this build has one. */
  transport: SyncTransport | null;
  /** Running once the phone is paired. */
  engine: SyncEngine | null;
}

const SyncContext = createContext<SyncValue>({ transport: null, engine: null });

/**
 * Runs the sync engine for the life of the app once the phone has a device
 * token. Without a server config, nothing runs and records stay on the phone.
 */
export function SyncProvider({
  config,
  transport: given,
  children,
}: {
  config: ServerConfig | null;
  transport?: SyncTransport;
  children: ReactNode;
}) {
  const db = useDb();
  const transport = useMemo(() => given ?? (config ? new SupabaseTransport(config) : null), [given, config]);
  const token = useQuery(async (d) => {
    const row = await d.meta.get('device_token');
    return typeof row?.value === 'string' ? row.value : null;
  });
  const [engine, setEngine] = useState<SyncEngine | null>(null);

  useEffect(() => {
    if (!transport || !token) return;
    const next = new SyncEngine(db, transport);
    next.start();
    setEngine(next);
    return () => {
      next.stop();
      setEngine(null);
    };
  }, [db, transport, token]);

  const value = useMemo(() => ({ transport, engine }), [transport, engine]);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncValue {
  return useContext(SyncContext);
}

const IDLE: EngineState = { sending: 0, failures: 0, lastError: null, nextRetryAt: null, stopped: null };
const noop = () => () => {};

export function useEngineState(): EngineState {
  const { engine } = useSync();
  return useSyncExternalStore(engine?.subscribe ?? noop, engine?.getState ?? (() => IDLE));
}

/** What the sync pill should say right now (R-SYNC-2). */
export function useSyncStatus(): SyncPillStatus {
  const { online } = useConnection();
  const { sending } = useEngineState();
  const counts = useQuery(outboxCounts) ?? { queued: 0, needsAdmin: 0 };
  return syncPillStatus({ online, sending, ...counts });
}
