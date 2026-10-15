/**
 * Rounding rules of the anonymous payload.
 *
 * The extension applies these before a number leaves the browser. The schemas enforce the
 * result (UTC hours, multiples of 10), so a payload that skipped the rounding is rejected.
 */
export const HOUR_MS = 3_600_000;
export const LINES_GRANULARITY = 10;

/** Rounds a timestamp to the nearest hour and returns it as an ISO 8601 UTC string. */
export function roundToHour(at: Date | number | string): string {
  const ms = typeof at === 'string' ? Date.parse(at) : typeof at === 'number' ? at : at.getTime();
  if (!Number.isFinite(ms)) {
    throw new TypeError(`Cannot round an invalid date: ${String(at)}`);
  }
  return new Date(Math.round(ms / HOUR_MS) * HOUR_MS).toISOString();
}

/**
 * Rounds a line count to a multiple of 10. Negative and invalid input is treated as 0.
 *
 * `u` in [0, 1) picks the rounding: 0.5 (the default) rounds half up to the nearest 10. A
 * uniform `u` rounds without bias: 3 lines become 10 with probability 0.3, else 0, so small
 * counts such as a one-line comment keep their expected value instead of always vanishing.
 */
export function roundLines(lines: number, u = 0.5): number {
  if (!Number.isFinite(lines) || lines <= 0) return 0;
  const unit = Math.min(Math.max(u, 0), 1 - Number.EPSILON);
  return Math.floor(lines / LINES_GRANULARITY + unit) * LINES_GRANULARITY;
}

/**
 * Rounds a duration in hours up to the next integer. Up, not to the nearest, so that the
 * server's "more than N hours" tests stay exact: ceil(x) > N exactly when x > N.
 * Negative and invalid input is treated as 0.
 */
export function ceilHours(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.ceil(hours);
}
