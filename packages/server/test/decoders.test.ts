import { describe, expect, it } from 'vitest';

import {
  DECODERS,
  readContractVersion,
  versionStatus,
  type Decoder,
} from '../src/decoders/index.ts';

describe('versionStatus', () => {
  it('tells supported, retired and unknown majors apart', () => {
    expect(versionStatus(1)).toBe('supported');
    expect(versionStatus(99)).toBe('unknown');
    expect(versionStatus(1, new Map<number, Decoder>(), new Set([1]))).toBe('retired');
    expect(versionStatus(2, DECODERS, new Set([1]))).toBe('unknown');
  });
});

describe('readContractVersion', () => {
  it('reads an integer major and nothing else', () => {
    expect(readContractVersion({ contractVersion: 1 })).toBe(1);
    expect(readContractVersion({ contractVersion: '1' })).toBeUndefined();
    expect(readContractVersion({ contractVersion: 1.5 })).toBeUndefined();
    expect(readContractVersion({})).toBeUndefined();
    expect(readContractVersion(null)).toBeUndefined();
    expect(readContractVersion('x')).toBeUndefined();
  });
});
