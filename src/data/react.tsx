import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db as defaultDb } from './db';
import type { KauntaDB } from './db';
import { seedDatabase } from './seedDb';

const DbContext = createContext<KauntaDB>(defaultDb);

/**
 * Makes the local store available to screens and holds rendering until it is
 * ready. Without a server (`demo`), a new phone starts with the handoff sample
 * data. With one, the data comes from the server when the phone is paired.
 */
export function DbProvider({
  db = defaultDb,
  demo = true,
  seed = seedDatabase,
  children,
}: {
  db?: KauntaDB;
  demo?: boolean;
  /** How a demo store gets its sample data (the counter's, or the admin's full day). */
  seed?: (db: KauntaDB) => Promise<unknown>;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(!demo);
  useEffect(() => {
    if (!demo) return;
    let cancelled = false;
    void seed(db).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [db, demo, seed]);
  return <DbContext.Provider value={db}>{ready ? children : null}</DbContext.Provider>;
}

export function useDb(): KauntaDB {
  return useContext(DbContext);
}

/** Re-runs `query` whenever the rows it read change, on this tab or another. */
export function useQuery<T>(query: (db: KauntaDB) => Promise<T>, deps: unknown[] = []): T | undefined {
  const db = useDb();
  return useLiveQuery(() => query(db), [db, ...deps]);
}

/** Whether the phone has a network, and since when it has been in that state. */
export function useConnection(): { online: boolean; since: Date } {
  const [state, setState] = useState(() => ({ online: navigator.onLine, since: new Date() }));
  useEffect(() => {
    const update = () =>
      setState((current) => (current.online === navigator.onLine ? current : { online: navigator.onLine, since: new Date() }));
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return state;
}
