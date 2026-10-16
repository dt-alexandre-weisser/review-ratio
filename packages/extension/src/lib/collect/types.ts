import type { LinesByClass } from '../scoring/classes.ts';
import type { ReviewAction } from '../scoring/model.ts';

/** An ↑ record before rounding. */
export interface UpInput {
  /** Review node id, to key the Viewed snapshot. */
  reviewId: string;
  tMs: number;
  action: ReviewAction;
  linesByClass: LinesByClass;
  commentedLinesByClass: LinesByClass;
  viewedLinesByClass: LinesByClass;
  waitedHoursWithoutReview: number;
}

/** A ↓ record before rounding. */
export interface DownInput {
  prKey: string;
  readyAtMs: number;
  linesByClass: LinesByClass;
}
