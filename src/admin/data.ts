import { useQuery } from '../data/react';
import type { DayData } from '../domain/admin';
import { localTime } from '../domain/time';
import type { BusinessDay, Device, Id, Instant, Person } from '../domain/types';
import type { Locale } from '../lib/i18n';

export interface AdminDay extends DayData {
  devices: Device[];
}

/** Everything the admin screens need for one business day, kept live. */
export function useDayData(day: BusinessDay): AdminDay | undefined {
  return useQuery(
    async (db) => {
      const [bar, people, devices, products, sizes, kegs, orders, approvals, shifts, dayClose] = await Promise.all([
        db.bar.toCollection().first(),
        db.people.toArray(),
        db.devices.toArray(),
        db.products.toArray(),
        db.sizes.toArray(),
        db.kegs.toArray(),
        db.orders.where('business_day').equals(day).toArray(),
        db.approvals.toArray(),
        db.shifts.toArray(),
        db.dayCloses.get(day),
      ]);
      const ids = orders.map((o) => o.id);
      const [lines, payments] = await Promise.all([
        db.lines.where('order_id').anyOf(ids).toArray(),
        db.payments.where('order_id').anyOf(ids).toArray(),
      ]);
      if (!bar) return undefined;
      const kegLines = await db.lines.where('keg_id').anyOf(kegs.map((k) => k.id)).toArray();
      const kegOrders = await db.orders.bulkGet([...new Set(kegLines.map((l) => l.order_id))]);
      const kegSales = { lines: kegLines, orders: kegOrders.filter((o) => o !== undefined) };
      return { bar, people, devices, products, sizes, kegs, orders, lines, payments, approvals, shifts, dayClose: dayClose ?? null, kegSales };
    },
    [day],
  );
}

export function useWaitingCount(): number {
  return useQuery((db) => db.approvals.where('status').equals('waiting').count()) ?? 0;
}

const DAYS = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  sw: ['Jumapili', 'Jumatatu', 'Jumanne', 'Jumatano', 'Alhamisi', 'Ijumaa', 'Jumamosi'],
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 10 Nov" / "Jumanne 10 Nov" for a business day. */
export function dayLabel(day: BusinessDay, locale: Locale): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  return `${DAYS[locale][d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Nairobi wall-clock time, "21:58". */
export const hhmm = (instant: Instant): string => localTime(instant);

export function personName(people: readonly Person[], id: Id | null | undefined): string {
  if (!id) return '';
  return people.find((p) => p.id === id)?.name ?? id;
}

export function deviceName(devices: readonly Device[], id: Id | null | undefined): string | null {
  if (!id) return null;
  return devices.find((d) => d.id === id)?.name ?? null;
}

/** Previous / next calendar business day. */
export function shiftDay(day: BusinessDay, by: number): BusinessDay {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + by * 86_400_000).toISOString().slice(0, 10);
}
