import { payloadV1, type } from '@review-ratio/contract';

import type { Payload } from '../model.ts';
import type { DecodeResult, Decoder } from './types.ts';

/** Decoder of contract major 1. Validates the wire payload and maps it to the canonical model. */
export const decoderV1: Decoder = {
  major: 1,
  decode(raw: unknown): DecodeResult {
    const result = payloadV1(raw);
    if (result instanceof type.errors) {
      return { ok: false, problems: result.map((problem) => problem.message) };
    }
    const payload: Payload = {
      contractVersion: result.contractVersion,
      up: result.up.map((record) => ({
        tMs: Date.parse(record.t),
        action: record.action,
        linesByClass: record.linesByClass,
        commentedLinesByClass: record.commentedLinesByClass,
        viewedLinesByClass: record.viewedLinesByClass,
        waitedHoursWithoutReview: record.waitedHoursWithoutReview,
      })),
      down: result.down.map((record) => ({
        prKey: record.prKey,
        readyAtMs: Date.parse(record.readyAt),
        ...(record.closedAt === undefined ? {} : { closedAtMs: Date.parse(record.closedAt) }),
        linesByClass: record.linesByClass,
      })),
    };
    return { ok: true, payload };
  },
};
