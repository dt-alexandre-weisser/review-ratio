export interface Recorded {
  url: string;
  init: RequestInit;
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** A `fetch` that routes to a handler and records every call. */
export function fakeFetch(handler: Handler): typeof fetch & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fn = (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return Promise.resolve(handler(new URL(url), init));
  };
  return Object.assign(fn, { calls });
}
