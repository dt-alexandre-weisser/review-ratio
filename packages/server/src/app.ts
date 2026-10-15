import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { PUBLISHED_CLASSES } from './classes.ts';
import { DECODERS, RETIRED_MAJORS, readContractVersion, type Decoder } from './decoders/index.ts';
import { score } from './formula.ts';
import { rateLimit, type RateLimitOptions } from './rate-limit.ts';

export const SERVER_VERSION = '0.1.0';

/** Largest accepted request body. A full 7-day payload is a few kilobytes. */
export const MAX_BODY_BYTES = 256 * 1024;

export type ErrorCode =
  | 'not_found'
  | 'invalid_json'
  | 'invalid_payload'
  | 'unsupported_version'
  | 'upgrade_required'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal';

export interface ErrorBody {
  error: { code: ErrorCode; message: string; problems?: string[] };
}

export interface AppOptions {
  /** Server clock, injectable for tests. */
  now?: () => number;
  decoders?: ReadonlyMap<number, Decoder>;
  retiredMajors?: ReadonlySet<number>;
  /** Rate limit of `POST /score`. Off when absent; each entry point sets it with a trusted key. */
  rateLimit?: RateLimitOptions;
  /** Logger for one line per request. `null` disables logging. Never receives a body. */
  log?: ((line: string) => void) | null;
}

function fail(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  problems?: string[],
) {
  const body: ErrorBody = { error: { code, message, ...(problems ? { problems } : {}) } };
  return c.json(body, status);
}

/** Allowed browser origins: the extension itself and local development pages. */
export function isAllowedOrigin(origin: string): boolean {
  return (
    /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
    /^moz-extension:\/\/[0-9a-f-]{36}$/.test(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
}

export function createApp(options: AppOptions = {}) {
  const now = options.now ?? Date.now;
  const decoders = options.decoders ?? DECODERS;
  const retired = options.retiredMajors ?? RETIRED_MAJORS;
  const log =
    options.log === undefined
      ? (line: string) => {
          console.info(line);
        }
      : options.log;

  const app = new Hono();

  app.use(requestId());
  // An API, read cross-origin by the extension: allow cross-origin reads of the responses.
  app.use(secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  app.use(
    cors({
      origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 600,
    }),
  );
  if (log) {
    app.use(async (c, next) => {
      const started = now();
      await next();
      const ms = now() - started;
      log(
        `${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${ms}ms id=${c.get('requestId')}`,
      );
    });
  }
  if (options.rateLimit) {
    app.use('/score', rateLimit({ now, ...options.rateLimit }));
  }

  app.get('/health', (c) =>
    c.json({
      ok: true,
      version: SERVER_VERSION,
      contract: { supported: [...decoders.keys()].sort(), retired: [...retired].sort() },
    }),
  );

  app.get('/classes', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json({
      classes: PUBLISHED_CLASSES.map(({ name, globs }) => ({ name, globs: [...globs] })),
    });
  });

  app.post(
    '/score',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        fail(c, 413, 'payload_too_large', `Body larger than ${MAX_BODY_BYTES} bytes.`),
    }),
    async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return fail(c, 400, 'invalid_json', 'Body must be JSON.');
      }

      const major = readContractVersion(raw);
      if (major === undefined) {
        return fail(c, 400, 'invalid_payload', 'contractVersion must be an integer.');
      }
      const decoder = decoders.get(major);
      if (!decoder) {
        if (retired.has(major)) {
          return fail(
            c,
            426,
            'upgrade_required',
            `Contract major ${major} is retired. Update the extension.`,
          );
        }
        return fail(
          c,
          400,
          'unsupported_version',
          `Contract major ${major} is unknown to this server.`,
        );
      }

      const decoded = decoder.decode(raw);
      if (!decoded.ok) {
        return fail(
          c,
          400,
          'invalid_payload',
          'Payload does not match the contract.',
          decoded.problems,
        );
      }

      c.header('Cache-Control', 'no-store');
      return c.json(score(decoded.payload, now()));
    },
  );

  app.notFound((c) => fail(c, 404, 'not_found', 'No such route.'));
  app.onError((error, c) => {
    console.error(`request ${c.get('requestId')} failed:`, error);
    return fail(c, 500, 'internal', 'Internal error.');
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
