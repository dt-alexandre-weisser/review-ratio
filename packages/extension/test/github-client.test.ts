import { describe, expect, it } from 'vitest';

import {
  GitHubAuthError,
  GitHubError,
  GitHubRateLimitError,
  createGitHubClient,
  normalizeLogin,
} from '../src/lib/github/client.ts';
import { fakeFetch, json } from './helpers/fetch.ts';

function rawPr(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-10-14T10:00:00Z',
    closedAt: null,
    headRefOid: 'h',
    baseRefOid: 'b',
    author: { login: 'alice', __typename: 'User' },
    assignees: { nodes: [{ login: 'me' }] },
    timelineItems: { nodes: [{ createdAt: '2026-10-14T11:00:00Z' }] },
    files: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ path: 'a.ts', additions: 3, deletions: 1, viewerViewedState: 'VIEWED' }],
    },
    reviews: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: 'R1',
          state: 'APPROVED',
          submittedAt: '2026-10-14T12:00:00Z',
          body: '',
          author: { login: 'me', __typename: 'User' },
          commit: { oid: 'h' },
          comments: {
            nodes: [
              {
                id: 'C1',
                path: 'a.ts',
                line: 3,
                startLine: 1,
                originalLine: 3,
                originalStartLine: 1,
                replyTo: null,
              },
              {
                id: 'C2',
                path: 'a.ts',
                line: 3,
                startLine: null,
                originalLine: 3,
                originalStartLine: null,
                replyTo: { id: 'C0' },
              },
            ],
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('normalizeLogin', () => {
  it('lowercases and strips [bot]', () => {
    expect(normalizeLogin('GitHub-Actions[bot]')).toBe('github-actions');
  });
});

describe('createGitHubClient', () => {
  it('sends the token, API version and accept header', async () => {
    const fetchImpl = fakeFetch(() => json({ login: 'Me' }));
    const client = createGitHubClient({ token: 'tok', fetchImpl });
    expect(await client.viewer()).toEqual({ login: 'Me' });
    const headers = fetchImpl.calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['x-github-api-version']).toBe('2022-11-28');
    expect(fetchImpl.calls[0]!.url).toBe('https://api.github.com/user');
  });

  it('maps 401 to an auth error and rate limits to a rate-limit error', async () => {
    const unauthorized = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch(() => json({}, { status: 401 })),
    });
    await expect(unauthorized.viewer()).rejects.toBeInstanceOf(GitHubAuthError);

    const limited = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch(() =>
        json(
          {},
          {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
          },
        ),
      ),
    });
    const error = await limited.viewer().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAtMs).toBe(1_800_000_000_000);

    const secondary = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch(() => json({}, { status: 429, headers: { 'retry-after': '60' } })),
    });
    await expect(secondary.viewer()).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it('wraps network failures and other errors', async () => {
    const offline = createGitHubClient({
      token: 't',
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(offline.viewer()).rejects.toThrow(/unreachable/);
    const broken = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch(() => json({}, { status: 500 })),
    });
    await expect(broken.viewer()).rejects.toBeInstanceOf(GitHubError);
    const forbidden = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch(() => json({}, { status: 403 })),
    });
    await expect(forbidden.viewer()).rejects.not.toBeInstanceOf(GitHubRateLimitError);
  });

  it('paginates search and keeps pull requests only', async () => {
    const fetchImpl = fakeFetch((url) => {
      const page = Number(url.searchParams.get('page'));
      const items = Array.from({ length: page === 1 ? 100 : 30 }, (_, i) => ({
        number: page * 1000 + i,
        repository_url: 'https://api.github.com/repos/DiliTrust/app',
        draft: false,
        updated_at: '2026-10-15T00:00:00Z',
        ...(i === 0 ? {} : { pull_request: {} }),
      }));
      return json({ total_count: 130, items });
    });
    const client = createGitHubClient({ token: 't', fetchImpl });
    const results = await client.searchPullRequests('is:pr org:DiliTrust');
    expect(fetchImpl.calls).toHaveLength(2);
    expect(results).toHaveLength(128);
    const first = new URL(fetchImpl.calls[0]!.url);
    expect(first.searchParams.get('q')).toBe('is:pr org:DiliTrust');
    expect(first.searchParams.get('per_page')).toBe('100');
  });

  it('stops searching at the page cap', async () => {
    const fetchImpl = fakeFetch(() =>
      json({
        total_count: 5000,
        items: Array.from({ length: 100 }, (_, i) => ({
          number: i,
          repository_url: 'https://api.github.com/repos/a/b',
          draft: false,
          updated_at: '',
          pull_request: {},
        })),
      }),
    );
    const client = createGitHubClient({ token: 't', fetchImpl, maxSearchPages: 2 });
    await client.searchPullRequests('q');
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('reads a pull request with one GraphQL query and maps it', async () => {
    const fetchImpl = fakeFetch(() => json({ data: { repository: { pullRequest: rawPr() } } }));
    const client = createGitHubClient({ token: 't', fetchImpl });
    const details = await client.pullRequest('DiliTrust', 'app', 7);
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]!.url).toBe('https://api.github.com/graphql');
    const sent = JSON.parse(fetchImpl.calls[0]!.init.body as string);
    expect(sent.variables).toEqual({ owner: 'DiliTrust', name: 'app', number: 7 });
    expect(details).toMatchObject({
      owner: 'DiliTrust',
      repo: 'app',
      number: 7,
      author: { login: 'alice', type: 'User' },
      assignees: ['me'],
      readyForReviewAt: '2026-10-14T11:00:00Z',
      headRefOid: 'h',
      baseRefOid: 'b',
      files: [{ path: 'a.ts', additions: 3, deletions: 1, viewerViewedState: 'VIEWED' }],
    });
    expect(details.reviews[0]).toMatchObject({
      id: 'R1',
      commitOid: 'h',
      author: { login: 'me', type: 'User' },
    });
    expect(details.reviews[0]!.comments.map((c) => c.isReply)).toEqual([false, true]);
  });

  it('follows the files and reviews pages', async () => {
    const fetchImpl = fakeFetch((_url, init) => {
      const { query, variables } = JSON.parse(init.body as string) as {
        query: string;
        variables: { after?: string };
      };
      if (query.startsWith('query PullRequestFiles')) {
        return json({
          data: {
            repository: {
              pullRequest: {
                files: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { path: 'b.ts', additions: 1, deletions: 0, viewerViewedState: 'UNVIEWED' },
                  ],
                },
              },
            },
          },
        });
      }
      if (query.startsWith('query PullRequestReviews')) {
        expect(variables.after).toBe('rev-cursor');
        return json({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ ...rawPr().reviews.nodes[0], id: 'R2', author: null, commit: null }],
                },
              },
            },
          },
        });
      }
      return json({
        data: {
          repository: {
            pullRequest: rawPr({
              author: { login: 'renovate', __typename: 'Bot' },
              timelineItems: { nodes: [] },
              files: {
                ...rawPr().files,
                pageInfo: { hasNextPage: true, endCursor: 'file-cursor' },
              },
              reviews: {
                ...rawPr().reviews,
                pageInfo: { hasNextPage: true, endCursor: 'rev-cursor' },
              },
            }),
          },
        },
      });
    });
    const client = createGitHubClient({ token: 't', fetchImpl });
    const details = await client.pullRequest('o', 'r', 1);
    expect(fetchImpl.calls).toHaveLength(3);
    expect(details.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(details.reviews.map((r) => r.id)).toEqual(['R1', 'R2']);
    expect(details.reviews[1]).toMatchObject({ author: null, commitOid: null });
    expect(details.author).toEqual({ login: 'renovate', type: 'Bot' });
    expect(details.readyForReviewAt).toBeNull();
  });

  it('reports GraphQL errors and missing pull requests', async () => {
    const notFound = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch(() => json({ data: { repository: { pullRequest: null } } })),
    });
    await expect(notFound.pullRequest('o', 'r', 1)).rejects.toMatchObject({ status: 404 });
    const erroring = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch(() => json({ errors: [{ message: 'nope', type: 'NOT_FOUND' }] })),
    });
    await expect(erroring.pullRequest('o', 'r', 1)).rejects.toMatchObject({ status: 404 });
    const other = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch(() => json({ errors: [{ message: 'boom' }] })),
    });
    await expect(other.pullRequest('o', 'r', 1)).rejects.toThrow(/boom/);
    const empty = createGitHubClient({ token: 't', fetchImpl: fakeFetch(() => json({})) });
    await expect(empty.pullRequest('o', 'r', 1)).rejects.toThrow(/without data/);
    const http = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch(() => json({}, { status: 502 })),
    });
    await expect(http.pullRequest('o', 'r', 1)).rejects.toMatchObject({ status: 502 });
  });

  it('compares two commits in one request and returns null when GitHub cannot', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.pathname.endsWith('/compare/gone...h')) return json({}, { status: 404 });
      return json({ files: [{ filename: 'a.ts', changes: 4, patch: '…' }] });
    });
    const client = createGitHubClient({ token: 't', fetchImpl });
    expect(await client.compare('DiliTrust', 'app', 'b', 'h')).toEqual([
      { filename: 'a.ts', changes: 4 },
    ]);
    const url = new URL(fetchImpl.calls[0]!.url);
    expect(url.pathname).toBe('/repos/DiliTrust/app/compare/b...h');
    expect(url.searchParams.get('per_page')).toBe('1');
    expect(await client.compare('DiliTrust', 'app', 'gone', 'h')).toBeNull();
    const failing = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch(() => json({}, { status: 500 })),
    });
    await expect(failing.compare('o', 'r', 'a', 'b')).rejects.toBeInstanceOf(GitHubError);
  });
});
