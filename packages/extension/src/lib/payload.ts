/**
 * Builds the anonymous payload: numbers only, rounded as the contract requires, validated
 * against the frozen schema before it leaves the browser.
 *
 * Covered, Viewed and ↓ lines round to the nearest 10, so equal sizes on both sides round alike
 * and the anchor invariant holds. Commented lines round to a multiple of 10 without bias: a
 * one-line comment would otherwise always round to 0 and erase the comment term. The rounding
 * direction is drawn from a hash of the review id, so it is the same on every refresh.
 */
import {
  LATEST_CONTRACT_VERSION,
  ceilHours,
  payloadV1,
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

/** Rounds every class to the nearest 10, or without bias when a seed is given. */
export function roundLinesByClass(lines: LinesByClassV1, unbiasedSeed?: string): LinesByClassV1 {
  const out: Partial<Record<FileClass, number>> = {};
  for (const [cls, n] of Object.entries(lines) as [FileClass, number | undefined][]) {
    const u = unbiasedSeed === undefined ? 0.5 : hashUnit(`${unbiasedSeed}:${cls}`);
    const rounded = roundLines(n ?? 0, u);
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
      linesByClass: roundLinesByClass(r.linesByClass),
      commentedLinesByClass: roundLinesByClass(r.commentedLinesByClass, `${r.reviewId}:commented`),
      viewedLinesByClass: roundLinesByClass(r.viewedLinesByClass),
      waitedHoursWithoutReview: ceilHours(r.waitedHoursWithoutReview),
    })),
    down: down.map((r) => ({
      prKey: r.prKey,
      readyAt: roundToHour(r.readyAtMs),
      ...(r.closedAtMs === null ? {} : { closedAt: roundToHour(r.closedAtMs) }),
      linesByClass: roundLinesByClass(r.linesByClass),
    })),
  };
  const result = payloadV1(candidate);
  if (result instanceof type.errors) {
    throw new Error(`payload violates contract v${LATEST_CONTRACT_VERSION}: ${result.summary}`);
  }
  return result;
}
