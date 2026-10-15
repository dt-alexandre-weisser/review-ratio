import anchor from './v1/anchor.json' with { type: 'json' };
import clockSkew from './v1/clock-skew.json' with { type: 'json' };
import downOnly from './v1/down-only.json' with { type: 'json' };
import empty from './v1/empty.json' with { type: 'json' };
import mixed from './v1/mixed.json' with { type: 'json' };
import upOnly from './v1/up-only.json' with { type: 'json' };

/** A fixture payload with the server clock it was written against. */
export interface Fixture {
  name: string;
  description: string;
  /** ISO 8601. The server scores the payload as if it received it at this time. */
  now: string;
  /** Raw payload as the extension would send it, before decoding. */
  payload: unknown;
}

function named(name: string, raw: { description: string; now: string; payload: unknown }): Fixture {
  return { name, description: raw.description, now: raw.now, payload: raw.payload };
}

/** Fixture payloads of every contract major, keyed by major. */
export const FIXTURES_BY_MAJOR: Readonly<Record<number, readonly Fixture[]>> = {
  1: [
    named('empty', empty),
    named('anchor', anchor),
    named('mixed', mixed),
    named('up-only', upOnly),
    named('down-only', downOnly),
    named('clock-skew', clockSkew),
  ],
};
