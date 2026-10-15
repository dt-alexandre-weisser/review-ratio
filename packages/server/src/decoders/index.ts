import { decoderV1 } from './v1.ts';
import type { Decoder } from './types.ts';

/**
 * One decoder per supported contract major. Installed extensions keep running old builds, so a
 * major stays here until it is retired on purpose.
 */
export const DECODERS: ReadonlyMap<number, Decoder> = new Map([[decoderV1.major, decoderV1]]);

/**
 * Majors that once existed and are no longer accepted. A payload of a retired major gets
 * `426 Upgrade Required`, and the badge tells the developer to update the extension.
 */
export const RETIRED_MAJORS: ReadonlySet<number> = new Set<number>();

export type VersionStatus = 'supported' | 'retired' | 'unknown';

export function versionStatus(
  major: number,
  decoders: ReadonlyMap<number, Decoder> = DECODERS,
  retired: ReadonlySet<number> = RETIRED_MAJORS,
): VersionStatus {
  if (decoders.has(major)) return 'supported';
  if (retired.has(major)) return 'retired';
  return 'unknown';
}

/** Reads the contract major from a raw payload without validating the rest of it. */
export function readContractVersion(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null || !('contractVersion' in raw)) return undefined;
  const value = raw.contractVersion;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export type { DecodeResult, Decoder } from './types.ts';
