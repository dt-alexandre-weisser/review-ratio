import type { Payload } from '../model.ts';

export type DecodeResult = { ok: true; payload: Payload } | { ok: false; problems: string[] };

export interface Decoder {
  readonly major: number;
  decode(raw: unknown): DecodeResult;
}
