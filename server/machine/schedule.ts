/**
 * Daily schedule in the worker timezone (default Asia/Novokuznetsk, UTC+7, no DST).
 * The run for local date D starts at RUN_AT_LOCAL_HOUR so the TOP-10 is ready before 08:00.
 * `tick` is what a cron/systemd timer calls (VL-004C); here it is exercised by tests and the CLI.
 */
import type { ISODate } from '../../src/domain/types';
import { WORKER_TIMEZONE } from './worker';

export const RUN_AT_LOCAL_HOUR = 6;

export function localParts(now: Date, timeZone = WORKER_TIMEZONE): { date: ISODate; hour: number } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function localToday(now: Date, timeZone = WORKER_TIMEZONE): ISODate {
  return localParts(now, timeZone).date;
}

/** Which daily run is due at `now` (null = before today's start time). */
export function dueRun(now: Date, timeZone = WORKER_TIMEZONE): { asOf: ISODate } | null {
  const { date, hour } = localParts(now, timeZone);
  return hour >= RUN_AT_LOCAL_HOUR ? { asOf: date } : null;
}

export function addDays(d: ISODate, n: number): ISODate {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Stale = the last successful run is older than yesterday (local). */
export function isStale(lastSuccessAsOf: ISODate | null, today: ISODate): boolean {
  return !lastSuccessAsOf || lastSuccessAsOf < addDays(today, -1);
}
