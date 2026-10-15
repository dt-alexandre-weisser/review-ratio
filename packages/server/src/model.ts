/**
 * The canonical model the formula scores. Every contract major decodes into it, so the formula
 * never depends on the wire format of a particular major.
 */
import type { LinesByClassV1, ReviewActionV1 } from '@review-ratio/contract';

export interface UpRecord {
  /** Review time, epoch milliseconds. */
  tMs: number;
  action: ReviewActionV1;
  linesByClass: LinesByClassV1;
  commentedLinesByClass: LinesByClassV1;
  viewedLinesByClass: LinesByClassV1;
  waitedHoursWithoutReview: number;
}

export interface DownRecord {
  prKey: string;
  /** Ready-for-review time, epoch milliseconds. */
  readyAtMs: number;
  closedAtMs?: number;
  linesByClass: LinesByClassV1;
}

export interface Payload {
  contractVersion: number;
  up: UpRecord[];
  down: DownRecord[];
}
