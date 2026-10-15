import type { LinesByClassV1, ReviewActionV1 } from '@review-ratio/contract';

/** An ↑ record before rounding. */
export interface UpInput {
  /** Review node id, to key the Viewed snapshot. */
  reviewId: string;
  tMs: number;
  action: ReviewActionV1;
  linesByClass: LinesByClassV1;
  commentedLinesByClass: LinesByClassV1;
  viewedLinesByClass: LinesByClassV1;
  waitedHoursWithoutReview: number;
}

/** A ↓ record before rounding. */
export interface DownInput {
  prKey: string;
  readyAtMs: number;
  closedAtMs: number | null;
  linesByClass: LinesByClassV1;
}
