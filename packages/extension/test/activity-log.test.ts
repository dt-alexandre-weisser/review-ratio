import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ActivityLog,
  FLUSH_DELAY_MS,
  MAX_BODY_TEXT,
  formatBody,
  parseGraphql,
  queryIdOf,
  readQuery,
  LOG_WINDOW_MS,
  MAX_ENTRIES,
  MAX_BATCH_ENTRIES,
  cleanUrl,
  clearActivity,
  describeBody,
  displayUrl,
  formatDuration,
  loggingFetch,
  readActivity,
  rowOf,
  summarize,
  toText,
  type ActivityEntry,
  type CallEntry,
} from '../src/lib/activity-log.ts';
import { NOW } from './helpers/github.ts';
import { memoryStorage } from './helpers/memory-storage.ts';

const MINUTE = 60_000;

function setup(initial: Record<string, unknown> = {}) {
  const area = memoryStorage(initial);
  let clock = NOW;
  let ids = 0;
  const errors: unknown[] = [];
  const log = new ActivityLog(area, {
    now: () => clock,
    randomId: () => `id${++ids}`,
    onError: (error) => errors.push(error),
  });
  return { area, log, errors, advance: (ms: number) => (clock += ms), now: () => clock };
}

function call(overrides: Partial<CallEntry> = {}): Omit<CallEntry, 'kind'> {
  return {
    at: NOW,
    method: 'GET',
    url: 'https://api.github.com/user',
    detail: null,
    status: 200,
    error: null,
    ms: 120,
    body: null,
    ...overrides,
  };
}

/** What `ActivityLog.call` takes: an entry without its kept body. */
function sent(overrides: Partial<CallEntry> = {}): Omit<CallEntry, 'kind' | 'body'> {
  const { body: _body, ...entry } = call(overrides);
  return entry;
}

const logKeys = (data: Record<string, unknown>) =>
  Object.keys(data).filter((k) => k.startsWith('activity:'));

afterEach(() => {
  vi.useRealTimers();
});

describe('ActivityLog', () => {
  it('writes buffered entries after a short delay, as one batch', async () => {
    vi.useFakeTimers();
    const { area, log } = setup();
    log.event('refresh started');
    log.call(sent());
    expect(logKeys(area.data)).toEqual([]);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(logKeys(area.data)).toEqual([`activity:${NOW}:2:id1`]);
    expect(area.data[`activity:${NOW}:2:id1`]).toHaveLength(2);
  });

  it('writes a full batch at once', async () => {
    const { area, log } = setup();
    for (let i = 0; i < MAX_BATCH_ENTRIES; i++) log.event(`event ${i}`);
    await vi.waitFor(() => {
      expect(logKeys(area.data)).toHaveLength(1);
    });
    await log.flush();
    expect(logKeys(area.data)).toHaveLength(1);
  });

  it('reads newest first, across batches and writers, without overwriting', async () => {
    const { area, log, advance, now } = setup();
    const other = new ActivityLog(area, { now, randomId: () => 'options' });
    log.event('first');
    await log.flush();
    advance(1000);
    other.event('second');
    await other.flush();
    advance(1000);
    log.event('third');
    await log.flush();
    const entries = await readActivity(area, now());
    expect(entries.map((e) => (e.kind === 'event' ? e.message : ''))).toEqual([
      'third',
      'second',
      'first',
    ]);
  });

  it('keeps the order of entries of the same millisecond, newest first', async () => {
    const { area, log, now } = setup();
    log.event('a');
    log.event('b');
    await log.flush();
    const entries = await readActivity(area, now());
    expect(entries.map((e) => (e.kind === 'event' ? e.message : ''))).toEqual(['b', 'a']);
  });

  it('forgets batches older than 30 minutes, from the future, and of an older layout', async () => {
    const { area, log, advance, now } = setup({ settings: { token: 'kept' } });
    log.event('old');
    await log.flush();
    advance(LOG_WINDOW_MS + 1);
    area.data[`activity:${now() + LOG_WINDOW_MS + 1}:1:future`] = [];
    area.data[`activity:${now()}:older-layout`] = [];
    log.event('new');
    await log.flush();
    expect(logKeys(area.data)).toEqual([`activity:${now()}:1:id2`]);
    expect(area.data['settings']).toEqual({ token: 'kept' });
  });

  it('keeps the newest batches within the entry cap, and always the newest one', async () => {
    const { area, log, now } = setup();
    for (let i = 1; i <= 60; i++) area.data[`activity:${now() - i}:100:x${i}`] = [];
    log.event('newest');
    await log.flush();
    const kept = logKeys(area.data);
    // The newest batch (1 entry) and the 49 newest of 100 entries: 4,901 entries.
    expect(kept).toHaveLength(50);
    expect(kept).toContain(`activity:${now()}:1:id1`);
    expect(kept).toContain(`activity:${now() - 49}:100:x49`);
    expect(kept).not.toContain(`activity:${now() - 50}:100:x50`);
    expect(MAX_ENTRIES).toBe(5_000);

    area.data[`activity:${now() + 1}:${MAX_ENTRIES + 1}:huge`] = [];
    await log.flush();
    expect(logKeys(area.data)).toEqual([`activity:${now() + 1}:${MAX_ENTRIES + 1}:huge`]);
  });

  it('shows only entries of the last 30 minutes and skips malformed ones', async () => {
    const { area, log, advance, now } = setup();
    log.event('29 minutes ago');
    await log.flush();
    advance(29 * MINUTE);
    area.data[`activity:${now()}:5:bad`] = [
      { kind: 'event', at: now() - LOG_WINDOW_MS - 1, message: 'too old, in a recent batch' },
      { kind: 'event', at: 'yesterday', message: 'bad time' },
      { kind: 'call', at: now(), method: 'GET' },
      { kind: 'other', at: now() },
      null,
    ];
    area.data[`activity:${now()}:1:notalist`] = { kind: 'event', at: now(), message: 'x' };
    area.data[`activity:${now()}:garbage`] = [{ kind: 'event', at: now(), message: 'old layout' }];
    const entries = await readActivity(area, now());
    expect(entries).toEqual([{ kind: 'event', at: NOW, message: '29 minutes ago' }]);
    advance(2 * MINUTE);
    expect(await readActivity(area, now())).toEqual([]);
  });

  it('clears its own keys only, of any layout', async () => {
    const { area, log } = setup({ settings: { token: 'kept' } });
    log.event('x');
    await log.flush();
    area.data['activity:older-layout'] = [];
    await clearActivity(area);
    expect(Object.keys(area.data)).toEqual(['settings']);
    await clearActivity(area);
    expect(Object.keys(area.data)).toEqual(['settings']);
  });

  it('never throws when storage fails, and still prunes after a failed write', async () => {
    const { area, log, errors, advance, now } = setup();
    log.event('old');
    await log.flush();
    advance(LOG_WINDOW_MS + 1);
    area.set = () => Promise.reject(new Error('quota exceeded'));
    log.event('x');
    await expect(log.flush()).resolves.toBeUndefined();
    expect(errors).toEqual([new Error('quota exceeded')]);
    expect(logKeys(area.data)).toEqual([]);
    area.getKeys = () => Promise.reject(new Error('storage gone'));
    await expect(log.flush()).resolves.toBeUndefined();
    expect(errors).toEqual([new Error('quota exceeded'), new Error('storage gone')]);
    expect(now()).toBeGreaterThan(NOW);
    // Without onError, the failure is swallowed.
    const silent = new ActivityLog(area);
    silent.event('y');
    await expect(silent.flush()).resolves.toBeUndefined();
  });

  it('clips long texts', async () => {
    const { area, log, now } = setup();
    log.event('m'.repeat(5000));
    log.call(
      sent({
        url: `https://x.test/${'u'.repeat(5000)}`,
        detail: 'd'.repeat(5000),
        error: 'e'.repeat(5000),
      }),
    );
    await log.flush();
    for (const entry of await readActivity(area, now())) {
      for (const value of Object.values(entry)) {
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(501);
      }
    }
  });
});

describe('loggingFetch', () => {
  it('logs each answered call with its method, URL, status and duration', async () => {
    const { area, log, now, advance } = setup();
    const inner = vi.fn(() => {
      advance(250);
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    const fetchLogged = loggingFetch(inner, log, now);
    const response = await fetchLogged('https://api.github.com/user', {
      headers: { authorization: 'Bearer github_pat_secret' },
    });
    expect(response.status).toBe(404);
    expect(inner).toHaveBeenCalledWith('https://api.github.com/user', {
      headers: { authorization: 'Bearer github_pat_secret' },
    });
    await log.flush();
    expect(await readActivity(area, now())).toEqual([
      {
        kind: 'call',
        at: NOW,
        method: 'GET',
        url: 'https://api.github.com/user',
        detail: null,
        status: 404,
        error: null,
        ms: 250,
        body: null,
      },
    ]);
    expect(JSON.stringify(area.data)).not.toContain('github_pat_secret');
  });

  it('reads the method and URL of a Request and of a URL object', async () => {
    const { area, log, now } = setup();
    const fetchLogged = loggingFetch(
      () => Promise.resolve(new Response(null, { status: 204 })),
      log,
      now,
    );
    await fetchLogged(new Request('https://api.github.com/graphql#x', { method: 'POST' }));
    await fetchLogged(new URL('http://127.0.0.1:8787/classes'));
    await fetchLogged('http://127.0.0.1:8787/score', { method: 'post', body: '{"up":[]}' });
    await log.flush();
    const calls = (await readActivity(area, now())).reverse() as CallEntry[];
    expect(calls.map((c) => [c.method, c.url, c.detail])).toEqual([
      ['POST', 'https://api.github.com/graphql', null],
      ['GET', 'http://127.0.0.1:8787/classes', null],
      ['POST', 'http://127.0.0.1:8787/score', '9 B sent'],
    ]);
  });

  it('logs a call that got no answer, and still fails it', async () => {
    const { area, log, now } = setup();
    const fetchLogged = loggingFetch(
      () => Promise.reject(new TypeError('Failed to fetch')),
      log,
      now,
    );
    await expect(fetchLogged('http://127.0.0.1:9/classes')).rejects.toThrow('Failed to fetch');
    // A rejection that is not an Error, as a broken polyfill could produce.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const notAnError = loggingFetch(() => Promise.reject('boom'), log, now);
    await expect(notAnError('http://127.0.0.1:9/score')).rejects.toBe('boom');
    await log.flush();
    const calls = (await readActivity(area, now())).reverse() as CallEntry[];
    expect(calls.map((c) => [c.status, c.error])).toEqual([
      [null, 'Failed to fetch'],
      [null, 'boom'],
    ]);
  });
});

describe('describeBody', () => {
  const graphql = (variables: unknown, query = 'query PullRequest($owner: String!) { x }') =>
    JSON.stringify({ query, variables });

  it('names the GraphQL operation and the PR it reads', () => {
    expect(describeBody(graphql({ owner: 'DiliTrust', name: 'app', number: 12 }))).toBe(
      'PullRequest DiliTrust/app#12',
    );
    expect(
      describeBody(
        graphql(
          { owner: 'DiliTrust', name: 'app', number: 12, after: 'Y3Vy' },
          'query PullRequestFiles { x }',
        ),
      ),
    ).toBe('PullRequestFiles DiliTrust/app#12, next page');
    expect(describeBody(graphql(null, '{ viewer { login } }'))).toBe('GraphQL');
    expect(describeBody(graphql({ owner: 'o', name: 'n', number: '12' }))).toBe('PullRequest');
  });

  it('gives the size of any other body, and nothing without a text body', () => {
    expect(describeBody('{"contractVersion":1}')).toBe('21 B sent');
    expect(describeBody(`{"up":"${'x'.repeat(2048)}"}`)).toBe('2.0 kB sent');
    expect(describeBody('{"query": not json')).toBe('18 B sent');
    expect(describeBody('{"query":42}')).toBe('12 B sent');
    expect(describeBody(undefined)).toBeNull();
    expect(describeBody(null)).toBeNull();
    expect(describeBody(new URLSearchParams('a=1'))).toBeNull();
  });
});

describe('cleanUrl and displayUrl', () => {
  it('drops credentials and fragments', () => {
    expect(cleanUrl('https://u:p@example.test/a?b=1#c')).toBe('https://example.test/a?b=1');
    expect(cleanUrl('not a url')).toBe('not a url');
  });

  it('shows host, path and a decoded query', () => {
    expect(
      displayUrl(
        'https://api.github.com/search/issues?q=is%3Apr+org%3ADiliTrust+updated%3A%3E%3D2026-10-08&page=1',
      ),
    ).toBe('api.github.com/search/issues?q=is:pr org:DiliTrust updated:>=2026-10-08&page=1');
    expect(displayUrl('https://x.test/a?q=%E0%A4%A')).toBe('x.test/a?q=%E0%A4%A');
    expect(displayUrl('not a url')).toBe('not a url');
  });
});

describe('rows, summary and text', () => {
  const entries: ActivityEntry[] = [
    { kind: 'event', at: NOW + 3000, message: 'refreshed: 1 review, 1 own PR' },
    {
      kind: 'call',
      ...call({
        at: NOW + 2000,
        method: 'POST',
        url: 'http://127.0.0.1:8787/score',
        detail: '1.2 kB sent',
        ms: 1500,
      }),
    },
    {
      kind: 'call',
      ...call({
        at: NOW + 1000,
        url: 'https://api.github.com/x',
        status: null,
        error: 'signal timed out',
        ms: 25_000,
      }),
    },
    { kind: 'call', ...call({ status: 500 }) },
    { kind: 'call', ...call({ url: 'not a url', status: 200 }) },
  ];

  it('formats durations', () => {
    expect(formatDuration(87.4)).toBe('87 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
  });

  it('turns entries into table rows', () => {
    expect(rowOf(entries[0]!)).toMatchObject({
      what: 'refreshed: 1 review, 1 own PR',
      event: true,
      failed: false,
    });
    expect(rowOf(entries[0]!).time).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(rowOf(entries[1]!)).toMatchObject({
      what: 'POST 127.0.0.1:8787/score',
      detail: '1.2 kB sent',
      result: '200',
      duration: '1.5 s',
      failed: false,
      event: false,
    });
    expect(rowOf(entries[2]!)).toMatchObject({
      result: 'failed',
      detail: 'signal timed out',
      failed: true,
    });
    expect(rowOf({ ...(entries[2] as CallEntry), detail: 'PullRequest o/n#1' }).detail).toBe(
      'PullRequest o/n#1 · signal timed out',
    );
    expect(rowOf(entries[3]!)).toMatchObject({ result: '500', failed: true });
  });

  it('counts the calls per host and the failures', () => {
    expect(summarize(entries)).toBe(
      '4 calls in the last 30 minutes: 2 to api.github.com, 1 to 127.0.0.1:8787, 1 to unknown host. 2 failed.',
    );
    expect(summarize([entries[1]!])).toBe('1 call in the last 30 minutes: 1 to 127.0.0.1:8787.');
    expect(summarize([entries[0]!])).toBe('No calls in the last 30 minutes.');
    expect(summarize([])).toBe('No calls in the last 30 minutes.');
  });

  it('writes the log as text, oldest first', () => {
    const lines = toText(entries.slice(0, 3)).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^\d\d:\d\d:\d\d {2}GET api\.github\.com\/x {2}→ failed in 25\.0 s {2}\(signal timed out\)$/,
    );
    expect(lines[1]).toMatch(
      /POST 127\.0\.0\.1:8787\/score {2}→ 200 in 1\.5 s {2}\(1\.2 kB sent\)$/,
    );
    expect(lines[2]).toMatch(/ {2}— refreshed: 1 review, 1 own PR$/);
    expect(toText([])).toBe('');
  });
});

describe('request bodies', () => {
  const QUERY = 'query PullRequest($owner: String!) { repository(owner: $owner) { id } }';
  const graphql = (variables: unknown) => JSON.stringify({ query: QUERY, variables });

  it('keeps GraphQL variables per call and the query text once', async () => {
    const { area, log, now } = setup();
    const fetchLogged = loggingFetch(() => Promise.resolve(new Response('{}')), log, now);
    for (const number of [1, 2, 3]) {
      await fetchLogged('https://api.github.com/graphql', {
        method: 'POST',
        body: graphql({ owner: 'DiliTrust', name: 'app', number, me: 'dev' }),
      });
    }
    await log.flush();
    const id = queryIdOf(QUERY);
    expect(Object.keys(area.data).filter((k) => k.startsWith('activityQuery:'))).toEqual([
      `activityQuery:${id}`,
    ]);
    const [latest] = (await readActivity(area, now())) as CallEntry[];
    expect(latest?.body).toEqual({
      kind: 'graphql',
      queryId: id,
      variables: '{"owner":"DiliTrust","name":"app","number":3,"me":"dev"}',
    });
    expect(await readQuery(area, id)).toBe(QUERY);
    expect(formatBody(latest!.body!, QUERY)).toBe(
      `${QUERY}\n\nvariables:\n{\n  "owner": "DiliTrust",\n  "name": "app",\n  "number": 3,\n  "me": "dev"\n}`,
    );

    // Not written again by this writer; written again by a new one (a restarted worker).
    await area.remove([`activityQuery:${id}`]);
    await fetchLogged('https://api.github.com/graphql', { method: 'POST', body: graphql({}) });
    await log.flush();
    expect(await readQuery(area, id)).toBeNull();
    const restarted = new ActivityLog(area, { now });
    restarted.call(sent({ method: 'POST' }), graphql({}));
    await restarted.flush();
    expect(await readQuery(area, id)).toBe(QUERY);
  });

  it('keeps other bodies as text, cut at a size', async () => {
    const { area, log, now } = setup();
    log.call(sent({ method: 'POST' }), '{"contractVersion":1,"up":[]}');
    log.call(sent({ method: 'POST' }), 'x'.repeat(MAX_BODY_TEXT + 10));
    log.call(sent({ method: 'POST' }), '{"query": broken');
    await log.flush();
    const [broken, big, score] = (await readActivity(area, now())) as CallEntry[];
    expect(score?.body).toEqual({
      kind: 'text',
      text: '{"contractVersion":1,"up":[]}',
      truncated: false,
    });
    expect(formatBody(score!.body!, null)).toBe('{\n  "contractVersion": 1,\n  "up": []\n}');
    expect(big?.body).toMatchObject({ kind: 'text', truncated: true });
    expect(formatBody(big!.body!, null)).toMatch(/\n… cut at 64 kB$/);
    expect(broken?.body).toEqual({ kind: 'text', text: '{"query": broken', truncated: false });
    expect(formatBody(broken!.body!, null)).toBe('{"query": broken');
  });

  it('says when the query text is gone, and reads GraphQL bodies only', () => {
    expect(formatBody({ kind: 'graphql', queryId: 'x', variables: '{}' }, null)).toBe(
      '(query text no longer in the log)\n\nvariables:\n{}',
    );
    expect(parseGraphql('{"query":"q","variables":{"a":1}}')).toEqual({
      query: 'q',
      variables: { a: 1 },
    });
    expect(parseGraphql('{"query":"q"}')).toEqual({ query: 'q', variables: null });
    expect(parseGraphql('{"query":1}')).toBeNull();
    expect(parseGraphql('{"up":[]}')).toBeNull();
  });

  it('reads entries of an earlier build without a body, and skips a malformed body', async () => {
    const { area, now } = setup();
    const { body: _body, ...old } = { kind: 'call', ...call() };
    area.data[`activity:${now()}:3:old`] = [
      old,
      { kind: 'call', ...call({ at: NOW + 1 }), body: { kind: 'graphql', queryId: 1 } },
      { kind: 'call', ...call({ at: NOW + 2 }), body: { kind: 'text', text: 'x' } },
    ];
    expect(await readActivity(area, now())).toEqual([{ kind: 'call', ...call() }]);
  });

  it('clears the query texts with the log', async () => {
    const { area, log } = setup({ settings: { token: 'kept' } });
    log.call(sent({ method: 'POST' }), graphql({}));
    await log.flush();
    await clearActivity(area);
    expect(Object.keys(area.data)).toEqual(['settings']);
  });
});
