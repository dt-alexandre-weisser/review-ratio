import { describe, expect, it } from 'vitest';

import { FIXTURES_BY_MAJOR } from '../fixtures/index.ts';
import {
  classesResponseV1,
  downRecordV1,
  linesByClassV1,
  payloadV1,
  scoreResponseV1,
  type,
  upRecordV1,
} from '../src/index.ts';

const validUp = {
  t: '2026-10-15T12:00:00Z',
  action: 'approve',
  linesByClass: { production: 400 },
  commentedLinesByClass: {},
  viewedLinesByClass: {},
  waitedHoursWithoutReview: 0,
};

const validDown = {
  prKey: '0f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b',
  readyAt: '2026-10-15T12:00:00Z',
  linesByClass: { production: 400 },
};

function errorsOf(result: unknown): string {
  return result instanceof type.errors ? result.summary : '';
}

describe('payloadV1', () => {
  it('accepts every v1 fixture', () => {
    for (const fixture of FIXTURES_BY_MAJOR[1]!) {
      const result = payloadV1(fixture.payload);
      expect(result, `${fixture.name}: ${errorsOf(result)}`).not.toBeInstanceOf(type.errors);
    }
  });

  it('accepts a minimal payload', () => {
    expect(payloadV1({ contractVersion: 1, up: [], down: [] })).not.toBeInstanceOf(type.errors);
  });

  it('rejects another contract version', () => {
    expect(errorsOf(payloadV1({ contractVersion: 2, up: [], down: [] }))).toContain(
      'contractVersion must be 1',
    );
  });

  it('rejects unknown top-level keys, so nothing identifying can sneak in', () => {
    const result = payloadV1({ contractVersion: 1, up: [], down: [], login: 'alice' });
    expect(errorsOf(result)).toContain('login must be removed');
  });

  it('rejects missing arrays', () => {
    expect(errorsOf(payloadV1({ contractVersion: 1, up: [] }))).toContain('down must be an array');
  });

  it('caps the number of records', () => {
    const up = Array.from({ length: 2001 }, () => validUp);
    expect(errorsOf(payloadV1({ contractVersion: 1, up, down: [] }))).toContain(
      'at most length 2000',
    );
    const down = Array.from({ length: 501 }, () => validDown);
    expect(errorsOf(payloadV1({ contractVersion: 1, up: [], down }))).toContain(
      'at most length 500',
    );
  });
});

describe('linesByClassV1', () => {
  it('accepts rounded counts and an empty object', () => {
    expect(linesByClassV1({})).toEqual({});
    expect(linesByClassV1({ production: 0, test: 10, generated: 1000000 })).toEqual({
      production: 0,
      test: 10,
      generated: 1000000,
    });
  });

  it('rejects counts that were not rounded to 10', () => {
    expect(errorsOf(linesByClassV1({ production: 15 }))).toContain('multiple of 10');
  });

  it('rejects negative, fractional and huge counts', () => {
    expect(errorsOf(linesByClassV1({ production: -10 }))).toContain('non-negative');
    expect(errorsOf(linesByClassV1({ production: 10.5 }))).toContain('multiple of 10');
    expect(errorsOf(linesByClassV1({ production: 1000010 }))).toContain('at most 1000000');
  });

  it('rejects unknown classes, including file extensions', () => {
    expect(errorsOf(linesByClassV1({ ts: 10 }))).toContain('ts must be removed');
  });
});

describe('upRecordV1', () => {
  it('accepts every action', () => {
    for (const action of ['approve', 'request_changes', 'comment', 'thread_reply']) {
      expect(upRecordV1({ ...validUp, action })).not.toBeInstanceOf(type.errors);
    }
  });

  it('rejects a timestamp that is not rounded to the hour', () => {
    expect(errorsOf(upRecordV1({ ...validUp, t: '2026-10-15T12:30:00Z' }))).toContain(
      'rounded to the hour',
    );
  });

  it('rejects a non-ISO timestamp', () => {
    expect(errorsOf(upRecordV1({ ...validUp, t: 'yesterday' }))).toContain('ISO 8601');
  });

  it('rejects an unknown action', () => {
    expect(errorsOf(upRecordV1({ ...validUp, action: 'merge' }))).toContain('action must be');
  });

  it('rejects fractional or negative waited hours', () => {
    expect(errorsOf(upRecordV1({ ...validUp, waitedHoursWithoutReview: 1.5 }))).toContain(
      'integer',
    );
    expect(errorsOf(upRecordV1({ ...validUp, waitedHoursWithoutReview: -1 }))).toContain(
      'non-negative',
    );
  });

  it('rejects identifying extras', () => {
    expect(errorsOf(upRecordV1({ ...validUp, repo: 'DiliTrust/x' }))).toContain(
      'repo must be removed',
    );
  });
});

describe('downRecordV1', () => {
  it('accepts an open and a closed PR', () => {
    expect(downRecordV1(validDown)).not.toBeInstanceOf(type.errors);
    expect(downRecordV1({ ...validDown, closedAt: '2026-10-15T13:00:00Z' })).not.toBeInstanceOf(
      type.errors,
    );
  });

  it('requires a UUID prKey, so a PR number cannot be used as key', () => {
    expect(errorsOf(downRecordV1({ ...validDown, prKey: 'DiliTrust/x#12' }))).toContain('UUID');
    expect(errorsOf(downRecordV1({ ...validDown, prKey: 12 }))).toContain('prKey must be');
  });

  it('rejects an unrounded closedAt', () => {
    expect(errorsOf(downRecordV1({ ...validDown, closedAt: '2026-10-15T13:00:01Z' }))).toContain(
      'rounded to the hour',
    );
  });
});

describe('response schemas', () => {
  it('accepts a score with and without ratio', () => {
    expect(scoreResponseV1({ up: 10, down: 5, ratio: 2 })).not.toBeInstanceOf(type.errors);
    expect(scoreResponseV1({ up: 10, down: 0, ratio: null })).not.toBeInstanceOf(type.errors);
    expect(errorsOf(scoreResponseV1({ up: -1, down: 0, ratio: null }))).toContain('non-negative');
    expect(errorsOf(scoreResponseV1({ up: 1, down: 0 }))).toContain('ratio');
  });

  it('accepts a classes response', () => {
    expect(
      classesResponseV1({ classes: [{ name: 'docs', globs: ['**/*.md'] }] }),
    ).not.toBeInstanceOf(type.errors);
    expect(errorsOf(classesResponseV1({ classes: [{ name: 'markdown', globs: [] }] }))).toContain(
      'name must be',
    );
  });
});
