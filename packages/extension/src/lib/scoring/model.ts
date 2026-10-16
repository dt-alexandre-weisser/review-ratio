/**
 * The records the formula scores, rounded and capped by `buildRecords` (records.ts).
 */
import type { LinesByClass } from './classes.ts';

export type ReviewAction = 'approve' | 'request_changes' | 'comment' | 'thread_reply';

/** One review I submitted. Earns ↑ RP. */
export interface UpRecord {
  /** Review time, epoch milliseconds, rounded to the hour. */
  tMs: number;
  action: ReviewAction;
  /** Lines changed since my previous review on the PR (the full diff on my first review). */
  linesByClass: LinesByClass;
  /** Lines covered by my review comments, each comment capped at `commentRangeCap` lines. */
  commentedLinesByClass: LinesByClass;
  /** Lines of the files I marked Viewed. */
  viewedLinesByClass: LinesByClass;
  /** Hours the PR had waited without any review when I reviewed it. 0 when someone reviewed before me. */
  waitedHoursWithoutReview: number;
}

/**
 * One PR I own that is, or was, in review. Earns ↓ RP. A merge or a close changes nothing: the
 * PR counts until day 7 of its ready-for-review time.
 */
export interface DownRecord {
  /** Ready-for-review time, epoch milliseconds, rounded to the hour. */
  readyAtMs: number;
  linesByClass: LinesByClass;
}

export interface Records {
  up: UpRecord[];
  down: DownRecord[];
}
