import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { clockOffset, seedAdminDatabase } from '../data/adminSeed';
import type { KauntaDB } from '../data/db';
import { DEMO_SAMPLE_BAR, demoStore, ensureMemberPeople, seedNewDemoBar } from '../admin/bars';
import type { AuditLookups } from '../admin/auditText';
import { todaySummary } from '../domain/admin';
import type { TodaySummary } from '../domain/admin';
import { businessDayOf } from '../domain/time';
import type { AuditEvent, BusinessDay } from '../domain/types';
import type { PlatformBar } from './platform';

/** What the platform screens show of one bar, from that bar's store in this browser. */
export interface BarSnapshot {
  barId: string;
  day: BusinessDay;
  today: TodaySummary;
  lookups: AuditLookups;
  /** The latest audit rows, newest first. */
  activity: AuditEvent[];
}

/** Where the platform screens read a bar from: this browser's demo stores, or (on the server) a pull of it as Kaunta. */
export interface SnapshotSource {
  storeFor: (barId: string) => KauntaDB;
  prepare: (bar: PlatformBar) => Promise<KauntaDB>;
}

let source: SnapshotSource | null = null;

export function setSnapshotSource(next: SnapshotSource | null): void {
  source = next;
}

/** Pull the bars again (after Kaunta changed one, and every 20 s on the server). */
const bumps = new Set<() => void>();
export function refreshSnapshots(): void {
  bumps.forEach((b) => b());
}

const storeFor = (barId: string) => (source ? source.storeFor(barId) : demoStore(barId));
const prepare = (bar: PlatformBar) => (source ? source.prepare(bar) : prepareDemo(bar));

/** The store of a bar, filled the way admin fills it, so the platform can read any bar before anyone opened it. */
async function prepareDemo(bar: PlatformBar): Promise<KauntaDB> {
  const db = demoStore(bar.id);
  if (bar.id === DEMO_SAMPLE_BAR) {
    await seedAdminDatabase(db);
    await ensureMemberPeople(db, bar.id);
  } else {
    await seedNewDemoBar(db, bar);
  }
  return db;
}

async function snapshot(barId: string, db: KauntaDB): Promise<BarSnapshot | null> {
  const bar = await db.bar.toCollection().first();
  if (!bar) return null;
  // The sample bar runs on its own clock (the sample night); a real bar on real time.
  const now = new Date(Date.now() + (await clockOffset(db)));
  const day = businessDayOf(now, bar.day_start);
  const [people, devices, products, sizes, orders, lines, approvals, kegs, payments, activity] = await Promise.all([
    db.people.toArray(),
    db.devices.toArray(),
    db.products.toArray(),
    db.sizes.toArray(),
    db.orders.toArray(),
    db.lines.toArray(),
    db.approvals.toArray(),
    db.kegs.toArray(),
    db.payments.toArray(),
    db.auditEvents.orderBy('at').reverse().limit(15).toArray(),
  ]);
  const todays = orders.filter((o) => o.business_day === day);
  return {
    barId,
    day,
    today: todaySummary({ orders: todays, lines, payments }),
    lookups: { people, devices, products, sizes, orders, lines, approvals, kegs },
    activity,
  };
}

/** Every bar's snapshot, kept live (sales at a counter show up as they happen). */
export function useBarSnapshots(bars: PlatformBar[]): Map<string, BarSnapshot> | undefined {
  const key = bars.map((b) => `${b.id}:${b.name}`).join('|');
  const [ready, setReady] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const bump = () => setRound((n) => n + 1);
    bumps.add(bump);
    const every = source ? setInterval(bump, 20_000) : null;
    return () => {
      bumps.delete(bump);
      if (every) clearInterval(every);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(bars.map(prepare)).then(
      () => {
        if (!cancelled) setReady(key);
      },
      // A bar that could not be pulled shows what this browser has of it.
      () => {
        if (!cancelled) setReady(key);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the bars
  }, [key, round]);
  return useLiveQuery(async () => {
    if (ready !== key) return undefined;
    const all = await Promise.all(bars.map((b) => snapshot(b.id, storeFor(b.id))));
    return new Map(all.filter((s): s is BarSnapshot => s !== null).map((s) => [s.barId, s]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key]);
}
