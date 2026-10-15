import { HOUR_MS } from '@review-ratio/contract';

export const DAY_MS = 24 * HOUR_MS;
/** The rolling window of the ratio, on both sides. */
export const WINDOW_MS = 7 * DAY_MS;
/** The badge refreshes at most this often. */
export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
/** A refresh older than this is considered dead and another one may start. */
export const REFRESH_LOCK_MS = 3 * 60 * 1000;

export function hoursBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / HOUR_MS;
}

export function parseIso(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`Invalid date: ${value}`);
  return ms;
}

/** `YYYY-MM-DD` in UTC, as GitHub search's `updated:` qualifier expects. */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `HH:MM` in the user's local time, for the stale tooltip. */
export function localClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
