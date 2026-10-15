import { describe, expect, it } from 'vitest';

import { ceilHours, roundLines, roundToHour } from '../src/index.ts';

describe('roundToHour', () => {
  it('rounds to the nearest hour', () => {
    expect(roundToHour('2026-10-15T12:29:59.999Z')).toBe('2026-10-15T12:00:00.000Z');
    expect(roundToHour('2026-10-15T12:30:00Z')).toBe('2026-10-15T13:00:00.000Z');
    expect(roundToHour(new Date('2026-10-15T23:45:00Z'))).toBe('2026-10-16T00:00:00.000Z');
    expect(roundToHour(Date.parse('2026-10-15T00:00:00Z'))).toBe('2026-10-15T00:00:00.000Z');
  });

  it('rejects invalid dates', () => {
    expect(() => roundToHour('not a date')).toThrow(TypeError);
    expect(() => roundToHour(Number.NaN)).toThrow(TypeError);
  });
});

describe('roundLines', () => {
  it('rounds to the nearest 10', () => {
    expect(roundLines(0)).toBe(0);
    expect(roundLines(4)).toBe(0);
    expect(roundLines(5)).toBe(10);
    expect(roundLines(14)).toBe(10);
    expect(roundLines(15)).toBe(20);
    expect(roundLines(1234)).toBe(1230);
  });

  it('rounds by the given unit: up when the remainder plus u reaches 10', () => {
    expect(roundLines(3, 0)).toBe(0);
    expect(roundLines(3, 0.69)).toBe(0);
    expect(roundLines(3, 0.7)).toBe(10);
    expect(roundLines(3, 0.99)).toBe(10);
    expect(roundLines(20, 0.99)).toBe(20);
    expect(roundLines(1, 1)).toBe(10);
    expect(roundLines(10, 1)).toBe(10);
  });

  it('is unbiased with a uniform unit', () => {
    const n = 10_000;
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += roundLines(3, (i + 0.5) / n);
    expect(sum / n).toBeCloseTo(3, 1);
  });

  it('clamps negative and invalid input to 0', () => {
    expect(roundLines(-30)).toBe(0);
    expect(roundLines(Number.NaN)).toBe(0);
    expect(roundLines(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('ceilHours', () => {
  it('rounds up so that "more than N hours" stays exact', () => {
    expect(ceilHours(48)).toBe(48);
    expect(ceilHours(48.01)).toBe(49);
    expect(ceilHours(47.5)).toBe(48);
    expect(ceilHours(0)).toBe(0);
    expect(ceilHours(-1)).toBe(0);
    expect(ceilHours(Number.NaN)).toBe(0);
  });
});
