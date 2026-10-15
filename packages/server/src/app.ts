import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { PUBLISHED_CLASSES } from './classes.ts';
import { DECODERS, RETIRED_MAJORS, readContractVersion, type Decoder } from './decoders/index.ts';
import { score } from './formula.ts';
import { rateLimit, type RateLimitOptions } from './rate-limit.ts';
import { shapeProblem } from './shape.ts';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
  }
}

export const SERVER_VERSION = '0.1.0';

/**
 * Largest accepted request body. A typical 7-day payload is a few KiB; the largest payload the
 * schema accepts (500 ↑ and 200 ↓ records, every class filled) stays under this.
 */
export const MAX_BODY_BYTES = 512 * 1024;

/** Validation problems echoed back to the sender, at most. */
export const MAX_PROBLEMS = 10;

export type ErrorCode =
  | 'not_found'
  | 'invalid_json'
  | 'invalid_payload'
  | 'unsupported_version'
  | 'upgrade_required'
  | 'payload_too_large'
  | 'unsupported_media_type'
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

/**
 * Whether a request declares a JSON body. Requiring it makes every cross-site `fetch` a CORS
 * preflighted request, which the CORS policy refuses for foreign origins: a web page cannot then
 * spend a developer's rate limit with no-cors posts.
 */
export function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  const mediaType = header.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

const requireJson: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'POST' && !isJsonContentType(c.req.header('content-type'))) {
    return fail(c, 415, 'unsupported_media_type', 'Content-Type must be application/json.');
  }
  await next();
};

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

  // A fresh id per request. A client-supplied X-Request-Id is ignored, so logs are not steerable.
  app.use(async (c, next) => {
    const id = crypto.randomUUID();
    c.set('requestId', id);
    c.header('X-Request-Id', id);
    await next();
  });
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
  app.use('/score', requireJson);
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

      const tooLarge = shapeProblem(raw);
      if (tooLarge) {
        return fail(c, 400, 'invalid_payload', `Payload is malformed: ${tooLarge}.`);
      }

      const decoded = decoder.decode(raw);
      if (!decoded.ok) {
        return fail(
          c,
          400,
          'invalid_payload',
          'Payload does not match the contract.',
          decoded.problems.slice(0, MAX_PROBLEMS),
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
