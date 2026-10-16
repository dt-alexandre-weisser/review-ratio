/**
 * The formula. It runs in the extension, and the scoring page (src/scoring) renders every weight
 * and parameter below from these exports, so the published explanation cannot drift from the
 * code. Keep it pure: it takes the rounded records and the clock, and returns numbers. See
 * DESIGN.md › Formula for the rationale of each term.
 */
import { FILE_CLASSES, type FileClass, type LinesByClass } from './classes.ts';
import type { DownRecord, Records, ReviewAction, UpRecord } from './model.ts';
import { HOUR_MS } from './rounding.ts';

export const DAY_HOURS = 24;
export const WINDOW_HOURS = 7 * DAY_HOURS;
/** Decimals the ratio is rounded to. ↑ and ↓ round to whole points. */
export const RATIO_DECIMALS = 2;

/** Weight of each file class. Applied to both sides so ↑ and ↓ stay in the same unit. */
export const CLASS_WEIGHTS: Readonly<Record<FileClass, number>> = {
  production: 1.0,
  test: 0.7,
  config: 0.5,
  ci: 0.5,
  tooling: 0.4,
  docs: 0.3,
  chore: 0.2,
  generated: 0.1,
};

/** Weight of the review action, applied to the covered lines. */
export const ACTION_WEIGHTS: Readonly<Record<ReviewAction, number>> = {
  approve: 1.0,
  request_changes: 1.0,
  comment: 0.4,
  /** A thread reply without a review earns the commented-lines term only. */
  thread_reply: 0,
};

export const PARAMETERS = {
  /** Applied to each weighted line of a comment range (`start_line..line`). */
  commentMultiplier: 10,
  /** Lines of one comment's range that count, at most. Applied by collect/up.ts, per comment. */
  commentRangeCap: 20,
  /** Applied to each weighted line of a file marked Viewed. */
  viewedBonus: 0.2,
  /** Multiplier when the PR had waited more than this many hours with no review. */
  rescueMultiplier: 1.5,
  rescueAfterHours: 48,
  /** Decay: 1.0 for the first 24h, then linear down to `decayFloor` at day 7, then 0. */
  decayFullHours: DAY_HOURS,
  decayFloor: 0.3,
  /**
   * A record dated up to this far in the future counts as age 0: the extension rounds times to
   * the nearest hour, and clocks drift. Further in the future, the record counts for nothing.
   */
  futureToleranceHours: 2,
  /** Size malus tiers of ↓, applied to marginal weighted lines. */
  sizeTiers: [
    { upTo: 400, factor: 1.0 },
    { upTo: 1_000, factor: 1.5 },
    { upTo: Number.POSITIVE_INFINITY, factor: 2.0 },
  ],
} as const;

/** Σ classWeight × lines over a lines-by-class record. Reads the known classes only. */
export function weightedLines(lines: LinesByClass): number {
  let total = 0;
  for (const cls of FILE_CLASSES) total += CLASS_WEIGHTS[cls] * (lines[cls] ?? 0);
  return total;
}

/**
 * Decay by age in hours. 1.0 during the first 24h, then linear down to 0.3 at day 7, then 0.
 * A small negative age (hour rounding, clock drift) counts as 0; a record further in the future
 * than `futureToleranceHours` counts for nothing, so a forged date cannot avoid the decay.
 */
export function decay(ageHours: number): number {
  if (!Number.isFinite(ageHours) || ageHours < -PARAMETERS.futureToleranceHours) return 0;
  const age = Math.max(0, ageHours);
  if (age <= PARAMETERS.decayFullHours) return 1;
  if (age >= WINDOW_HOURS) return 0;
  const span = WINDOW_HOURS - PARAMETERS.decayFullHours;
  const progress = (age - PARAMETERS.decayFullHours) / span;
  return 1 - progress * (1 - PARAMETERS.decayFloor);
}

/** Size malus of ↓, on marginal lines so there is no cliff at a tier boundary. */
export function sizeTiers(weighted: number): number {
  let remaining = Math.max(0, weighted);
  let floor = 0;
  let cost = 0;
  for (const tier of PARAMETERS.sizeTiers) {
    const span = Math.min(remaining, tier.upTo - floor);
    if (span <= 0) break;
    cost += span * tier.factor;
    remaining -= span;
    floor = tier.upTo;
  }
  return cost;
}

function hoursBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / HOUR_MS;
}

/** ↑ RP of one review I submitted. */
export function scoreUp(record: UpRecord, nowMs: number): number {
  const covered = weightedLines(record.linesByClass) * ACTION_WEIGHTS[record.action];
  const commented = weightedLines(record.commentedLinesByClass) * PARAMETERS.commentMultiplier;
  const viewed = weightedLines(record.viewedLinesByClass) * PARAMETERS.viewedBonus;
  const rescue =
    record.waitedHoursWithoutReview > PARAMETERS.rescueAfterHours ? PARAMETERS.rescueMultiplier : 1;
  return (covered + commented + viewed) * decay(hoursBetween(record.tMs, nowMs)) * rescue;
}

/**
 * ↓ RP of one PR I own. The clock starts when the PR was marked ready for review and never
 * resets: a review received, a merge or a close does not change the decay. The PR drops out at
 * day 7 through the decay reaching 0.
 */
export function scoreDown(record: DownRecord, nowMs: number): number {
  return (
    sizeTiers(weightedLines(record.linesByClass)) * decay(hoursBetween(record.readyAtMs, nowMs))
  );
}

export interface Score {
  up: number;
  down: number;
  /** `null` when ↓ is 0. The badge shows ∞ (↑ > 0) or — (both 0). */
  ratio: number | null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Scores the records as of `nowMs`. Pure. */
export function score(records: Records, nowMs: number): Score {
  let up = 0;
  for (const record of records.up) up += scoreUp(record, nowMs);
  let down = 0;
  for (const record of records.down) down += scoreDown(record, nowMs);
  if (!Number.isFinite(up) || !Number.isFinite(down)) {
    throw new RangeError('score is not finite');
  }
  up = round(up, 0);
  down = round(down, 0);
  return { up, down, ratio: down === 0 ? null : round(up / down, RATIO_DECIMALS) };
}
