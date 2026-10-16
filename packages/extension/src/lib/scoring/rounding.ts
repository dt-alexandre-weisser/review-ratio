/**
 * Rounding applied to every record before it is scored.
 *
 * Times round to the hour and line counts to a multiple of 10. The rounding is part of the
 * formula: it sets the age a record decays by, and it makes equal sizes on both sides round
 * alike, which the anchor invariant needs.
 */
export const HOUR_MS = 3_600_000;
export const LINES_GRANULARITY = 10;

/** Rounds a timestamp, in epoch milliseconds, to the nearest hour. */
export function roundToHour(ms: number): number {
  if (!Number.isFinite(ms)) {
    throw new TypeError(`Cannot round an invalid date: ${String(ms)}`);
  }
  return Math.round(ms / HOUR_MS) * HOUR_MS;
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
