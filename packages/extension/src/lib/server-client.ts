/**
 * Talks to the review-ratio server. Two calls: the published class globs, and the score.
 */
import {
  classesResponseV1,
  scoreResponseV1,
  type,
  type PayloadV1,
  type ScoreResponseV1,
} from '@review-ratio/contract';

import { GlobError, compileGlob, unsupportedSyntax, type CompiledPattern } from './glob.ts';
import type { PublishedClass } from './storage.ts';

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

/** The server retired our contract major: `426 Upgrade Required`. */
export class UpgradeRequiredError extends ServerError {
  constructor() {
    super('update the extension', 426);
    this.name = 'UpgradeRequiredError';
  }
}

export type Fetch = typeof fetch;

export interface ServerClient {
  fetchClasses(): Promise<PublishedClass[]>;
  score(payload: PayloadV1): Promise<ScoreResponseV1>;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Bounds on the published globs: the server must not be able to make classification costly. */
export const MAX_GLOBS = 500;
export const MAX_GLOB_LENGTH = 200;
/** Brace alternatives over all globs. */
export const MAX_PATTERNS = 1_000;
/** Path segments per pattern. */
export const MAX_SEGMENTS = 16;

/** Why a classes response cannot be used, or `null`. */
export function classesProblem(
  classes: readonly { name: string; globs: readonly string[] }[],
): string | null {
  if (new Set(classes.map((c) => c.name)).size !== classes.length) return 'a class is listed twice';
  const globs = classes.flatMap((c) => c.globs);
  if (globs.length > MAX_GLOBS) return `more than ${MAX_GLOBS} globs`;
  if (globs.some((g) => g.length === 0 || g.length > MAX_GLOB_LENGTH)) {
    return `a glob is empty or longer than ${MAX_GLOB_LENGTH} characters`;
  }
  let patterns = 0;
  for (const glob of globs) {
    let compiled: CompiledPattern[];
    try {
      compiled = compileGlob(glob);
      const unsupported = unsupportedSyntax(glob);
      if (unsupported) return `${glob}: ${unsupported}`;
    } catch (error) {
      return error instanceof GlobError ? `${glob}: ${error.message}` : 'a glob cannot be read';
    }
    if (compiled.some((pattern) => pattern.segments.length > MAX_SEGMENTS)) {
      return `a glob has more than ${MAX_SEGMENTS} path segments`;
    }
    patterns += compiled.length;
    if (patterns > MAX_PATTERNS) return `more than ${MAX_PATTERNS} patterns after brace expansion`;
  }
  return null;
}

export function createServerClient(baseUrl: string, fetchImpl: Fetch = fetch): ServerClient {
  const base = baseUrl.replace(/\/+$/, '');

  async function call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ServerError(`server unreachable (${describe(error)})`, null);
    }
    if (res.status === 426) throw new UpgradeRequiredError();
    if (!res.ok) throw new ServerError(`server answered ${res.status}`, res.status);
    return res;
  }

  return {
    async fetchClasses() {
      const res = await call('/classes', {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      const body = classesResponseV1(await res.json());
      if (body instanceof type.errors) {
        throw new ServerError(`invalid classes response: ${body.summary}`, res.status);
      }
      const problem = classesProblem(body.classes);
      if (problem) throw new ServerError(`invalid classes response: ${problem}`, res.status);
      return body.classes.map((c) => ({ name: c.name, globs: [...c.globs] }));
    },
    async score(payload) {
      const res = await call('/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = scoreResponseV1(await res.json());
      if (body instanceof type.errors) {
        throw new ServerError(`invalid score response: ${body.summary}`, res.status);
      }
      return body;
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timeout' : error.message;
  return String(error);
}
