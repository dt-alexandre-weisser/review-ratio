/**
 * Turns what was collected from GitHub into the records the formula scores: rounded, capped, and
 * sorted.
 *
 * Covered, Viewed and ↓ lines round to the nearest 10, so equal sizes on both sides round alike
 * and the anchor invariant holds. Commented lines round to a multiple of 10 without bias: a
 * one-line comment would otherwise always round to 0 and erase the comment term. The rounding
 * direction is drawn from a hash of the review id, so it is the same on every refresh and the
 * badge does not flicker.
 */
import type { DownInput, UpInput } from '../collect/types.ts';
import type { FileClass, LinesByClass } from './classes.ts';
import type { Records } from './model.ts';
import { roundLines, roundToHour } from './rounding.ts';

/** Upper bound of a single line count: one huge data file must not dwarf a whole week. */
export const MAX_LINES = 1_000_000;
/** Upper bounds of records scored. A 7-day window of one human never needs more. */
export const MAX_UP_RECORDS = 500;
export const MAX_DOWN_RECORDS = 200;

/** FNV-1a, 32 bits, mapped to [0, 1). Not cryptographic: it only picks a rounding direction. */
export function hashUnit(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Rounds every class to the nearest 10, or without bias when a seed is given, and clamps it to
 * `MAX_LINES`.
 */
export function roundLinesByClass(lines: LinesByClass, unbiasedSeed?: string): LinesByClass {
  const out: LinesByClass = {};
  for (const [cls, n] of Object.entries(lines) as [FileClass, number | undefined][]) {
    const u = unbiasedSeed === undefined ? 0.5 : hashUnit(`${unbiasedSeed}:${cls}`);
    const rounded = Math.min(MAX_LINES, roundLines(n ?? 0, u));
    if (rounded > 0) out[cls] = rounded;
  }
  return out;
}

/** The newest `max` items, then sorted oldest first with ties in hash order. */
function newest<T>(
  items: readonly T[],
  max: number,
  at: (item: T) => number,
  key: (item: T) => string,
): T[] {
  const byTime = (a: T, b: T) => at(a) - at(b) || hashUnit(key(a)) - hashUnit(key(b));
  return [...items].sort(byTime).slice(-max);
}

export function buildRecords(up: readonly UpInput[], down: readonly DownInput[]): Records {
  // Past the limits, the oldest records go first: they carry the least weight after decay.
  const ups = newest(
    up,
    MAX_UP_RECORDS,
    (r) => r.tMs,
    (r) => r.reviewId,
  );
  const downs = newest(
    down,
    MAX_DOWN_RECORDS,
    (r) => r.readyAtMs,
    (r) => r.prKey,
  );
  return {
    up: ups.map((r) => ({
      tMs: roundToHour(r.tMs),
      action: r.action,
      linesByClass: roundLinesByClass(r.linesByClass),
      commentedLinesByClass: roundLinesByClass(r.commentedLinesByClass, `${r.reviewId}:commented`),
      viewedLinesByClass: roundLinesByClass(r.viewedLinesByClass),
      waitedHoursWithoutReview: r.waitedHoursWithoutReview,
    })),
    down: downs.map((r) => ({
      readyAtMs: roundToHour(r.readyAtMs),
      linesByClass: roundLinesByClass(r.linesByClass),
    })),
  };
}
