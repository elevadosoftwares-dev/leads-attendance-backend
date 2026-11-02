import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { env } from '../config/env';

const WORK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The work date (`YYYY-MM-DD`, company timezone) that a UTC instant falls on. */
export function toWorkDate(utc: Date, tz: string = env.APP_TIMEZONE): string {
  return formatInTimeZone(utc, tz, 'yyyy-MM-dd');
}

/** Today's work date in the company timezone. */
export function todayWorkDate(tz: string = env.APP_TIMEZONE): string {
  return toWorkDate(new Date(), tz);
}

/** Local time of day (`HH:mm`, company timezone) of a UTC instant. */
export function toLocalTime(utc: Date, tz: string = env.APP_TIMEZONE): string {
  return formatInTimeZone(utc, tz, 'HH:mm');
}

/** The UTC instant for a local `YYYY-MM-DD` + `HH:mm` in the company timezone. */
export function combineWorkDateAndTime(date: string, time: string, tz: string = env.APP_TIMEZONE): Date {
  if (!WORK_DATE_RE.test(date)) throw new Error(`Invalid work date: ${date}`);
  if (!HHMM_RE.test(time)) throw new Error(`Invalid time: ${time}`);
  return fromZonedTime(`${date}T${time}:00`, tz);
}

/** Adds calendar days to a work date (pure date arithmetic, no timezone involved). */
export function addDaysToWorkDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Day of week for a work date: 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWeekend(date: string): boolean {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}

/** The next Monday–Friday work date after `date`. */
export function nextWorkDate(date: string): string {
  let next = addDaysToWorkDate(date, 1);
  while (isWeekend(next)) next = addDaysToWorkDate(next, 1);
  return next;
}

/** First and last work dates of a `YYYY-MM` month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** Current month (`YYYY-MM`) in the company timezone. */
export function currentMonth(tz: string = env.APP_TIMEZONE): string {
  return formatInTimeZone(new Date(), tz, 'yyyy-MM');
}

/**
 * A clock-in is late when it is strictly after workDate + shiftStart + grace minutes,
 * evaluated in the company timezone.
 */
export function computeIsLate(
  clockInUtc: Date,
  workDate: string,
  shiftStart: string,
  graceMinutes: number = env.LATE_GRACE_MINUTES,
  tz: string = env.APP_TIMEZONE,
): boolean {
  const threshold = combineWorkDateAndTime(workDate, shiftStart, tz).getTime() + graceMinutes * 60_000;
  return clockInUtc.getTime() > threshold;
}

/** Whole minutes elapsed between two instants (never negative). */
export function elapsedMinutes(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
}

/** Serializes a Date as an ISO-8601 UTC string without milliseconds, e.g. `2026-10-16T00:54:00Z`. */
export function isoUtc(value: Date): string;
export function isoUtc(value: Date | null | undefined): string | null;
export function isoUtc(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
