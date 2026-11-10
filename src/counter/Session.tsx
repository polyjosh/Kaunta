import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { RecordContext } from '../data/outbox';
import { useQuery } from '../data/react';
import type { Device, Id, Person } from '../domain/types';

interface SessionValue {
  /** This phone. */
  device: Device | undefined;
  /** Who is logged in at this counter, or null. */
  person: Person | null;
  login: (personId: Id) => void;
  logout: () => void;
  /** R-SELL-3: the chosen server stays until changed or the user logs out. */
  serverId: Id | null;
  setServerId: (id: Id) => void;
  /** Stamps for a record made now. Only valid while someone is logged in. */
  recordContext: () => RecordContext;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Who is at the counter. Held in memory only: reloading the app or closing it
 * asks for the PIN again, which is what a shared device should do.
 */
export function SessionProvider({ children, initialPersonId = null }: { children: ReactNode; initialPersonId?: Id | null }) {
  const [personId, setPersonId] = useState<Id | null>(initialPersonId);
  const [serverId, setServerId] = useState<Id | null>(initialPersonId);

  const device = useQuery(async (db) => {
    const row = await db.meta.get('device_id');
    return typeof row?.value === 'string' ? db.devices.get(row.value) : undefined;
  });
  const person = useQuery(async (db) => (personId ? ((await db.people.get(personId)) ?? null) : null), [personId]);

  const login = useCallback((id: Id) => {
    setPersonId(id);
    setServerId(id);
  }, []);
  const logout = useCallback(() => {
    setPersonId(null);
    setServerId(null);
  }, []);

  const deviceId = device?.id;
  const value = useMemo<SessionValue>(
    () => ({
      device,
      person: person ?? null,
      login,
      logout,
      serverId,
      setServerId,
      recordContext: () => {
        if (!personId || !deviceId) throw new Error('Nobody is logged in at this counter');
        return { person_id: personId, device_id: deviceId };
      },
    }),
    [device, deviceId, person, personId, login, logout, serverId],
  );

  // Wait until the logged-in person has been read (the live query briefly holds the
  // previous answer), so a logged-in screen never bounces to the login redirect.
  if (personId && person?.id !== personId) return null;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
