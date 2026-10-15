/**
 * Builds the anonymous payload: numbers only, rounded as the contract requires, validated
 * against the frozen schema before it leaves the browser.
 *
 * Line counts are rounded to a multiple of 10 without bias. The rounding direction is drawn
 * from a hash of the review or PR key, so the same record rounds the same way on every refresh
 * and the badge does not flicker. Rounding to the nearest 10 instead would turn every one-line
 * comment into 0 and erase the comment term of the formula.
 */
import {
  LATEST_CONTRACT_VERSION,
  payloadV1,
  roundHours,
  roundLines,
  roundToHour,
  type,
  type FileClass,
  type LinesByClassV1,
  type PayloadV1,
} from '@review-ratio/contract';

import type { DownInput, UpInput } from './collect/types.ts';

/** FNV-1a, 32 bits, mapped to [0, 1). Not cryptographic: it only picks a rounding direction. */
export function hashUnit(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

export function roundLinesByClass(lines: LinesByClassV1, seed: string): LinesByClassV1 {
  const out: Partial<Record<FileClass, number>> = {};
  for (const [cls, n] of Object.entries(lines) as [FileClass, number | undefined][]) {
    const rounded = roundLines(n ?? 0, hashUnit(`${seed}:${cls}`));
    if (rounded > 0) out[cls] = rounded;
  }
  return out;
}

export function buildPayload(up: readonly UpInput[], down: readonly DownInput[]): PayloadV1 {
  const candidate = {
    contractVersion: LATEST_CONTRACT_VERSION,
    up: up.map((r) => ({
      t: roundToHour(r.tMs),
      action: r.action,
      linesByClass: roundLinesByClass(r.linesByClass, `${r.reviewId}:covered`),
      commentedLinesByClass: roundLinesByClass(r.commentedLinesByClass, `${r.reviewId}:commented`),
      viewedLinesByClass: roundLinesByClass(r.viewedLinesByClass, `${r.reviewId}:viewed`),
      waitedHoursWithoutReview: roundHours(r.waitedHoursWithoutReview),
    })),
    down: down.map((r) => ({
      prKey: r.prKey,
      readyAt: roundToHour(r.readyAtMs),
      ...(r.closedAtMs === null ? {} : { closedAt: roundToHour(r.closedAtMs) }),
      linesByClass: roundLinesByClass(r.linesByClass, `${r.prKey}:asked`),
    })),
  };
  const result = payloadV1(candidate);
  if (result instanceof type.errors) {
    throw new Error(`payload violates contract v${LATEST_CONTRACT_VERSION}: ${result.summary}`);
  }
  return result;
}
