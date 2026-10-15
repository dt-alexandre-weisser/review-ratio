import { PUBLISHED_CLASSES } from '@review-ratio/server';
import { describe, expect, it } from 'vitest';

import {
  MAX_GLOB_LENGTH,
  MAX_GLOBS,
  isBoundedGlob,
  ServerError,
  UpgradeRequiredError,
  classesProblem,
  createServerClient,
} from '../src/lib/server-client.ts';
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

describe('classesProblem', () => {
  it('refuses globs that would make classification costly or ambiguous', () => {
    expect(classesProblem([{ name: 'docs', globs: ['**/*.md'] }])).toBeNull();
    expect(
      classesProblem([
        { name: 'docs', globs: [] },
        { name: 'docs', globs: [] },
      ]),
    ).toMatch(/twice/);
    expect(
      classesProblem([{ name: 'docs', globs: new Array<string>(MAX_GLOBS + 1).fill('*.md') }]),
    ).toMatch(/more than/);
    expect(classesProblem([{ name: 'docs', globs: ['x'.repeat(MAX_GLOB_LENGTH + 1)] }])).toMatch(
      /longer/,
    );
    expect(classesProblem([{ name: 'docs', globs: [''] }])).toMatch(/empty/);
  });

  it('rejects such a response when fetching the classes', async () => {
    const client = createServerClient(
      'http://x',
      fakeFetch(() => json({ classes: [{ name: 'docs', globs: [''] }] })),
    );
    await expect(client.fetchClasses()).rejects.toBeInstanceOf(ServerError);
  });
});

describe('isBoundedGlob', () => {
  it('accepts every published glob', () => {
    for (const cls of PUBLISHED_CLASSES) {
      for (const glob of cls.globs) expect(isBoundedGlob(glob), glob).toBe(true);
    }
    expect(
      classesProblem(PUBLISHED_CLASSES.map((c) => ({ name: c.name, globs: [...c.globs] }))),
    ).toBeNull();
  });

  it('refuses globs that backtrack exponentially', () => {
    expect(isBoundedGlob('*a*a*a*a*a*a*a*a*a*a*a*a*b')).toBe(false);
    expect(isBoundedGlob(Array.from({ length: 12 }, () => '*a*').join('/'))).toBe(false);
    expect(isBoundedGlob('**/**/**/**/x')).toBe(false);
    expect(isBoundedGlob('{a,b}{c,d}{e,f}')).toBe(false);
    expect(isBoundedGlob('**/*.y*ml')).toBe(true);
  });

  it('keeps matching fast within the bounds, on deep and long paths', async () => {
    const { createClassifier } = await import('../src/lib/classify.ts');
    const classify = createClassifier([
      { name: 'docs', globs: ['**/*a*/**/**', '*a*/**/**/b', '{a,b,c}/**/*a*/{x,y}/**'] },
    ]);
    const deep = `${Array.from({ length: 200 }, () => 'aaaa').join('/')}/zzz`;
    const wide = Array.from({ length: 50 }, () => 'a'.repeat(255)).join('/');
    const started = performance.now();
    classify(deep);
    classify(wide);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
