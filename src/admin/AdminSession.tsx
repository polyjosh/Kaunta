import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '../data/react';
import { setAdminHere } from '../lib/adminHere';
import { clockOffset } from '../data/adminSeed';
import { KAUNTA_ACTOR } from '../data/adminEvents';
import type { AdminContext } from '../data/adminEvents';
import type { Person } from '../domain/types';
import type { BarSummary } from './bars';
import type { BarCodeChange } from './server';

interface SessionValue {
  person: Person;
  /** Passed to recordAdminEvent: who is deciding, on the admin's clock. */
  ctx: AdminContext;
  /** The admin clock: real time, or the demo's own night (see adminSeed). */
  now: () => Date;
  signOut?: () => void;
  /** R-DEV-1: a 6-digit code valid 10 minutes. Needs the server; the demo makes one that pairs nothing. */
  createPairingCode: (deviceName: string) => Promise<PairingCode>;
  /** True when there is no server behind this admin (the sample day). */
  demo: boolean;
  /** The bars this person runs, and the one open now. */
  bars: BarSummary[];
  barId: string | null;
  switchBar: (id: string) => void;
  /** Owners only: starts another bar and opens it. */
  createBar?: (name: string) => Promise<void>;
  /** Owners: the open bar's code becomes the one they chose (checked unique), or a fresh one. */
  changeBarCode?: (code?: string) => Promise<BarCodeChange>;
  /** The signed-in owner or manager's own account (username + password or PIN), when there is one. */
  account?: AccountChoice;
  /**
   * Kaunta (the super admin) opened this bar from /super: every owner tab, as
   * Kaunta. What Kaunta does is left out of what owners and managers see in
   * their logs; Kaunta sees it.
   */
  kaunta: boolean;
  /** Owners: how many bars they own and how many Kaunta allows (null = no limit). */
  barLimit?: { used: number; max: number | null };
}

export interface AccountChoice {
  /** Their platform account (demo), for the owner-only tools such as adding managers. */
  id?: string;
  username: string;
  /** Owners have a password, managers a 4-digit PIN. */
  secret: 'password' | 'pin';
  /** Kaunta set the password or PIN in force: suggest changing it. */
  pinSetByKaunta: boolean;
  changePin: (current: string, next: string) => Promise<'current' | 'invalid' | 'same' | null>;
}

export interface BarChoice {
  bars: BarSummary[];
  barId: string;
  switchBar: (id: string) => void;
  createBar?: (name: string) => Promise<void>;
  changeBarCode?: (code?: string) => Promise<BarCodeChange>;
  barLimit?: { used: number; max: number | null };
}

export interface PairingCode {
  code: string;
  expires_at: string;
}

/** Demo only: a code shown for the look of it. No phone can pair with it. */
const demoPairingCode = (now: () => Date) => async (): Promise<PairingCode> => ({
  code: String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0'),
  expires_at: new Date(now().getTime() + 10 * 60_000).toISOString(),
});

const SessionContext = createContext<SessionValue | null>(null);

/** Who Kaunta is in a bar's admin: not a person of the bar, so never on its staff list or counter. */
export const KAUNTA_PERSON: Person = {
  id: KAUNTA_ACTOR, name: 'Kaunta', initial: 'K', colour: '#F28C38', role: 'owner', login: 'password',
  pin_hash: null, pin_locked_until: null, failed_pin_attempts: 0, archived_at: null,
};

/** Hides what Kaunta did from owners and managers; Kaunta sees everything. */
export function visibleTo<E extends { actor_id: string }>(events: E[], kaunta: boolean): E[] {
  return kaunta ? events : events.filter((e) => e.actor_id !== KAUNTA_ACTOR);
}

/**
 * Who is signed in to admin. In demo mode that is the owner from the sample
 * data; with a server it is the person linked to the Supabase sign-in.
 */
export function AdminSessionProvider({
  personId,
  signOut,
  createPairingCode,
  bars,
  account,
  asKaunta = false,
  children,
}: {
  /** Opened by Kaunta from /super. */
  asKaunta?: boolean;
  personId?: string | null;
  signOut?: () => void;
  createPairingCode?: (deviceName: string) => Promise<PairingCode>;
  bars?: BarChoice;
  account?: AccountChoice;
  children: ReactNode;
}) {
  const loaded = useQuery(async (db) => {
    const offset = await clockOffset(db);
    const people = await db.people.toArray();
    // Signed in: exactly that person. Demo: the sample bar's owner.
    const person = asKaunta
      ? KAUNTA_PERSON
      : personId ? (people.find((p) => p.id === personId) ?? null) : (people.find((p) => p.role === 'owner' && !p.archived_at) ?? null);
    return { offset, person };
  }, [personId, asKaunta]);
  const value = useMemo<SessionValue | null>(() => {
    if (!loaded?.person) return null;
    const now = () => new Date(Date.now() + loaded.offset);
    return {
      person: loaded.person,
      now,
      ctx: { person_id: loaded.person.id, now },
      signOut: signOut
        ? () => {
            setAdminHere(null);
            signOut();
          }
        : undefined,
      createPairingCode: createPairingCode ?? demoPairingCode(now),
      demo: !createPairingCode,
      bars: bars?.bars ?? [],
      barId: bars?.barId ?? null,
      switchBar: bars?.switchBar ?? (() => {}),
      createBar: bars?.createBar,
      changeBarCode: bars?.changeBarCode,
      barLimit: bars?.barLimit,
      account,
      kaunta: asKaunta,
    };
  }, [loaded, signOut, createPairingCode, bars, account, asKaunta]);
  // The counter on this browser lets this owner or manager straight in (not Kaunta: it is no one at the counter).
  const herePerson = asKaunta ? undefined : value?.person.id;
  const hereBar = value?.barId;
  useEffect(() => {
    if (herePerson && hereBar) setAdminHere({ bar_id: hereBar, person_id: herePerson });
  }, [herePerson, hereBar]);
  if (!value) return null;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useAdmin(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useAdmin must be used inside <AdminSessionProvider>');
  return value;
}

/** The admin clock, re-read every `everyMs` so "now", countdowns and ageing stay current. */
export function useNow(everyMs = 30_000): Date {
  const { now } = useAdmin();
  const [value, setValue] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setValue(now()), everyMs);
    return () => clearInterval(id);
  }, [now, everyMs]);
  return value;
}
