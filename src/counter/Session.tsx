import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RecordContext } from '../data/outbox';
import { useQuery } from '../data/react';
import { hasAccess } from '../domain/pin';
import type { Device, Id, Person } from '../domain/types';

/** Saves what is on screen and not yet recorded (the tray on Sell), before a forced sign-out. */
export type Saver = () => Promise<void>;

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
  /** A screen with unsaved work registers how to save it; returns the unregister. */
  registerSaver: (saver: Saver) => () => void;
  /** Set when the last person was signed out because their access was removed. */
  removed: { name: string } | null;
  clearRemoved: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Who is at the counter. Held in memory only: reloading the app or closing it
 * asks for the PIN again, which is what a shared device should do.
 *
 * When an owner or manager suspends the person logged in (the change reaches
 * this phone with the next sync, or at once on the same browser), what is on
 * screen is saved and they are signed out straight away.
 */
export function SessionProvider({ children, initialPersonId = null }: { children: ReactNode; initialPersonId?: Id | null }) {
  const [personId, setPersonId] = useState<Id | null>(initialPersonId);
  const [serverId, setServerId] = useState<Id | null>(initialPersonId);
  const [removed, setRemoved] = useState<{ name: string } | null>(null);
  const savers = useRef(new Set<Saver>());

  const device = useQuery(async (db) => {
    const row = await db.meta.get('device_id');
    return typeof row?.value === 'string' ? db.devices.get(row.value) : undefined;
  });
  const person = useQuery(async (db) => (personId ? ((await db.people.get(personId)) ?? null) : null), [personId]);

  const login = useCallback((id: Id) => {
    setRemoved(null);
    setPersonId(id);
    setServerId(id);
  }, []);
  const logout = useCallback(() => {
    setPersonId(null);
    setServerId(null);
  }, []);
  const registerSaver = useCallback((saver: Saver) => {
    savers.current.add(saver);
    return () => void savers.current.delete(saver);
  }, []);
  const clearRemoved = useCallback(() => setRemoved(null), []);

  const lostAccess = !!person && person.id === personId && !hasAccess(person);
  useEffect(() => {
    if (!lostAccess || !person) return;
    let done = false;
    void (async () => {
      for (const save of [...savers.current]) {
        try {
          await save();
        } catch {
          // Nothing more can be saved; what was recorded before is safe.
        }
      }
      if (done) return;
      setRemoved({ name: person.name });
      setPersonId(null);
      setServerId(null);
    })();
    return () => {
      done = true;
    };
  }, [lostAccess, person]);

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
      registerSaver,
      removed,
      clearRemoved,
    }),
    [device, deviceId, person, personId, login, logout, serverId, registerSaver, removed, clearRemoved],
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
