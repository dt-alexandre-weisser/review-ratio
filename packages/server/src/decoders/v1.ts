import { downRecordV1, payloadV1, type, upRecordV1 } from '@review-ratio/contract';

import type { Payload } from '../model.ts';
import type { DecodeResult, Decoder } from './types.ts';

/** Validation stops once this many records failed: an invalid payload costs little to reject. */
const MAX_FAILED_RECORDS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates records one at a time and stops early, so that a payload made of hundreds of broken
 * records is rejected after a few of them instead of after building an error for each field.
 * Returns the problems found, empty when every record passed.
 */
function recordProblems(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  let failed = 0;
  const lists = [
    ['up', raw['up'], upRecordV1],
    ['down', raw['down'], downRecordV1],
  ] as const;
  for (const [name, list, schema] of lists) {
    if (!Array.isArray(list)) continue;
    for (const [index, item] of list.entries()) {
      const result = schema(item);
      if (result instanceof type.errors) {
        for (const problem of result) problems.push(`${name}[${index}]: ${problem.message}`);
        failed += 1;
        if (failed >= MAX_FAILED_RECORDS) return problems;
      }
    }
  }
  return problems;
}

/** Decoder of contract major 1. Validates the wire payload and maps it to the canonical model. */
export const decoderV1: Decoder = {
  major: 1,
  decode(raw: unknown): DecodeResult {
    const early = isRecord(raw) ? recordProblems(raw) : [];
    if (early.length > 0) return { ok: false, problems: early };

    // Every record passed: the frozen schema now checks the whole payload, envelope included.
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
