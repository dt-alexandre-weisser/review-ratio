import { describe, expect, it } from 'vitest';

import { ServerError, UpgradeRequiredError, createServerClient } from '../src/lib/server-client.ts';
import { fakeFetch, json } from './helpers/fetch.ts';

const payload = { contractVersion: 1 as const, up: [], down: [] };

describe('createServerClient', () => {
  it('fetches the class globs', async () => {
    const fetchImpl = fakeFetch(() => json({ classes: [{ name: 'docs', globs: ['**/*.md'] }] }));
    const client = createServerClient('http://127.0.0.1:8787/', fetchImpl);
    expect(await client.fetchClasses()).toEqual([{ name: 'docs', globs: ['**/*.md'] }]);
    expect(fetchImpl.calls[0]!.url).toBe('http://127.0.0.1:8787/classes');
  });

  it('posts the payload and validates the score', async () => {
    const fetchImpl = fakeFetch(() => json({ up: 10, down: 5, ratio: 2 }));
    const client = createServerClient('http://x', fetchImpl);
    expect(await client.score(payload)).toEqual({ up: 10, down: 5, ratio: 2 });
    expect(fetchImpl.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(fetchImpl.calls[0]!.init.body as string)).toEqual(payload);
  });

  it('throws UpgradeRequiredError on 426', async () => {
    const client = createServerClient(
      'http://x',
      fakeFetch(() => json({}, { status: 426 })),
    );
    await expect(client.score(payload)).rejects.toBeInstanceOf(UpgradeRequiredError);
  });

  it('throws ServerError on other failures', async () => {
    const down = createServerClient('http://x', () =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    await expect(down.score(payload)).rejects.toMatchObject({
      status: null,
      message: expect.stringContaining('unreachable'),
    });
    const timeout = createServerClient('http://x', () =>
      Promise.reject(new DOMException('t', 'TimeoutError')),
    );
    await expect(timeout.score(payload)).rejects.toThrow(/timeout/);
    const failing = createServerClient(
      'http://x',
      fakeFetch(() => json({}, { status: 500 })),
    );
    await expect(failing.score(payload)).rejects.toMatchObject({ status: 500 });
    const garbage = createServerClient(
      'http://x',
      fakeFetch(() => json({ up: 'x' })),
    );
    await expect(garbage.score(payload)).rejects.toBeInstanceOf(ServerError);
    const badClasses = createServerClient(
      'http://x',
      fakeFetch(() => json({ classes: [{ name: 'nope', globs: [] }] })),
    );
    await expect(badClasses.fetchClasses()).rejects.toThrow(/invalid classes/);
  });
});
