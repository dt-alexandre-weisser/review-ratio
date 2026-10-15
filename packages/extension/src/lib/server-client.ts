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
