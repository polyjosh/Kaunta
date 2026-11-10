import type { BusinessDay, Instant } from './types';

/** Africa/Nairobi is UTC+3 all year (no DST), so a fixed offset is exact. */
const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function parseHHmm(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`Expected a time like "06:00", got "${value}"`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes >= 24 * 60 || Number(match[2]) > 59) throw new RangeError(`Not a time of day: "${value}"`);
  return minutes;
}

function toMs(instant: Instant | Date): number {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (Number.isNaN(ms)) throw new TypeError(`Not a valid instant: ${String(instant)}`);
  return ms;
}

/**
 * R-DAY-1: a business day runs from `dayStart` to `dayStart` the next day,
 * Nairobi time. A sale at 02:14 on Wednesday belongs to Tuesday.
 */
export function businessDayOf(instant: Instant | Date, dayStart = '06:00'): BusinessDay {
  const shifted = toMs(instant) + NAIROBI_OFFSET_MS - parseHHmm(dayStart) * MINUTE_MS;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * The instant a Nairobi wall-clock time falls on within a business day.
 * Times before `dayStart` are after midnight, i.e. on the next calendar date.
 */
export function instantOnBusinessDay(day: BusinessDay, localTime: string, dayStart = '06:00'): Instant {
  const dayMs = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(dayMs)) throw new TypeError(`Not a business day: "${day}"`);
  const minutes = parseHHmm(localTime);
  const afterMidnight = minutes < parseHHmm(dayStart) ? DAY_MS : 0;
  return new Date(dayMs + afterMidnight + minutes * MINUTE_MS - NAIROBI_OFFSET_MS).toISOString();
}

/** Nairobi wall-clock time, "21:58". */
export function localTime(instant: Instant | Date): string {
  return new Date(toMs(instant) + NAIROBI_OFFSET_MS).toISOString().slice(11, 16);
}

/** Whole minutes from `from` to `to` (never negative: device clocks can step back). */
export function minutesBetween(from: Instant | Date, to: Instant | Date): number {
  return Math.max(0, Math.floor((toMs(to) - toMs(from)) / MINUTE_MS));
}
