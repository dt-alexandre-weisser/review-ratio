import { describe, expect, it } from 'vitest';

import { ClassificationBudgetError, createClassifier } from '../src/lib/classify.ts';
import {
  collectWindow,
  isFatal,
  parseRepositoryUrl,
  prRefKey,
  searchQueries,
  type CollectInput,
} from '../src/lib/collect/index.ts';
import { GitHubAuthError, GitHubError, GitHubRateLimitError } from '../src/lib/github/client.ts';
import type { GitHubClient } from '../src/lib/github/types.ts';
import { NOW, fakeGitHub, hoursAgo, pr, review, searchItem } from './helpers/github.ts';

const classify = createClassifier([]);
let uuid = 0;
const randomUUID = () => `00000000-0000-4000-8000-${String((uuid += 1)).padStart(12, '0')}`;

function input(github: GitHubClient, overrides: Partial<CollectInput> = {}): CollectInput {
  return {
    github,
    settings: { org: 'DiliTrust', excludedRepos: [] },
    classify,
    nowMs: NOW,
    prKeys: {},
    viewedSnapshots: {},
    compareCache: {},
    randomUUID,
    ...overrides,
  };
}

describe('helpers', () => {
  it('parses repository URLs', () => {
    expect(parseRepositoryUrl('https://api.github.com/repos/DiliTrust/app')).toEqual({
      owner: 'DiliTrust',
      repo: 'app',
    });
    expect(parseRepositoryUrl('https://api.github.com/orgs/x')).toBeNull();
  });

  it('keys PR refs case-insensitively', () => {
    expect(prRefKey({ owner: 'DiliTrust', repo: 'App', number: 3 })).toBe('dilitrust/app#3');
  });

  it('searches the org over the last 7 days, for reviews, own PRs and assigned bot PRs', () => {
    expect(searchQueries('DiliTrust', 'me', NOW)).toEqual([
      'is:pr org:DiliTrust updated:>=2026-10-08 reviewed-by:me',
      'is:pr org:DiliTrust updated:>=2026-10-08 author:me',
      'is:pr org:DiliTrust updated:>=2026-10-08 author:app/github-actions assignee:me',
    ]);
  });

  it('treats auth, rate-limit and classification-budget errors as fatal only', () => {
    expect(isFatal(new GitHubAuthError(401))).toBe(true);
    expect(isFatal(new GitHubRateLimitError(null))).toBe(true);
    expect(isFatal(new ClassificationBudgetError())).toBe(true);
    expect(isFatal(new GitHubError('boom', 502))).toBe(false);
    expect(isFatal(new Error('x'))).toBe(false);
  });
});

describe('collectWindow', () => {
  const reviewed = pr({ number: 1, myReviews: [review({ id: 'r1' })] });
  const own = pr({
    number: 2,
    author: { login: 'me', type: 'User' },
    readyForReviewAt: hoursAgo(3),
  });
  const excluded = pr({ repo: 'legacy', number: 3, myReviews: [review({ id: 'r3' })] });

  it('collects ↑ and ↓ across PRs, deduplicated, skipping excluded repos', async () => {
    const github = fakeGitHub({ prs: [reviewed, own, excluded] });
    const result = await collectWindow(
      input(github, { settings: { org: 'DiliTrust', excludedRepos: ['legacy'] } }),
    );
    expect(github.queries).toHaveLength(3);
    expect(result.up.map((r) => r.reviewId)).toEqual(['r1']);
    expect(result.down).toHaveLength(1);
    expect(Object.keys(result.prKeys)).toEqual(['dilitrust/app#2']);
    expect(result.prKeys['dilitrust/app#2']).toBe(result.down[0]!.prKey);
    expect(result).toMatchObject({ skipped: 0, total: 2 });
  });

  it('keeps existing PR keys and drops keys of PRs that left the window', async () => {
    const result = await collectWindow(
      input(fakeGitHub({ prs: [own] }), {
        prKeys: { 'dilitrust/app#2': 'kept-key', 'dilitrust/app#99': 'stale-key' },
      }),
    );
    expect(result.prKeys).toEqual({ 'dilitrust/app#2': 'kept-key' });
    expect(result.down[0]!.prKey).toBe('kept-key');
  });

  it('keeps the Viewed snapshots taken within the window, even of a PR skipped this time', async () => {
    const withViewed = pr({
      number: 5,
      files: [{ path: 'a.ts', additions: 10, deletions: 0, viewerViewedState: 'VIEWED' }],
      myReviews: [review({ id: 'r5' })],
    });
    const result = await collectWindow(
      input(fakeGitHub({ prs: [withViewed] }), {
        viewedSnapshots: {
          old: { linesByClass: { production: 10 }, takenAt: NOW - 8 * 24 * 3_600_000 },
          skipped: { linesByClass: { production: 20 }, takenAt: NOW - 3_600_000 },
        },
      }),
    );
    expect(Object.keys(result.viewedSnapshots).sort()).toEqual(['r5', 'skipped']);
  });

  it('caches comparisons and serves them without calling GitHub again', async () => {
    const twoReviews = pr({
      number: 7,
      myReviews: [
        review({ commitOid: 'c1', submittedAt: hoursAgo(3) }),
        review({ commitOid: 'head', submittedAt: hoursAgo(1) }),
      ],
    });
    const github = fakeGitHub({ prs: [twoReviews] });
    const first = await collectWindow(input(github));
    expect(github.compares).toEqual([
      ['fork', 'c1'],
      ['c1', 'head'],
    ]);
    expect(Object.keys(first.compareCache).sort()).toEqual([
      'dilitrust/app:c1...head',
      'dilitrust/app:fork...c1',
    ]);
    const second = await collectWindow(input(github, { compareCache: first.compareCache }));
    expect(github.compares).toHaveLength(2);
    expect(second.up).toEqual(first.up);
  });

  it('falls back to the PR diff when one comparison fails, and stops on an auth error', async () => {
    const twoReviews = pr({
      number: 8,
      myReviews: [
        review({ commitOid: 'c1', submittedAt: hoursAgo(3) }),
        review({ commitOid: 'head', submittedAt: hoursAgo(1) }),
      ],
    });
    const flaky = {
      ...fakeGitHub({ prs: [twoReviews] }),
      compare: () => Promise.reject(new GitHubError('502', 502)),
    };
    const result = await collectWindow(input(flaky));
    expect(result.up.map((r) => r.linesByClass)).toEqual([
      { production: 400 },
      { production: 400 },
    ]);
    expect(result.compareCache).toEqual({});

    const revoked = {
      ...fakeGitHub({ prs: [twoReviews] }),
      compare: () => Promise.reject(new GitHubAuthError(401)),
    };
    await expect(collectWindow(input(revoked))).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it('skips a PR GitHub cannot serve, and fails when most PRs fail', async () => {
    const prs = [1, 2, 3].map((n) => pr({ number: n, myReviews: [review({ id: `r${n}` })] }));
    const base = fakeGitHub({ prs });
    const oneBroken = {
      ...base,
      pullRequest: (o: string, r: string, n: number, me: string) =>
        n === 2 ? Promise.reject(new GitHubError('not found', 404)) : base.pullRequest(o, r, n, me),
    };
    const result = await collectWindow(input(oneBroken));
    expect(result.up.map((r) => r.reviewId).sort()).toEqual(['r1', 'r3']);
    expect(result).toMatchObject({ skipped: 1, total: 3 });

    const mostBroken = {
      ...base,
      pullRequest: (o: string, r: string, n: number, me: string) =>
        n === 1 ? base.pullRequest(o, r, n, me) : Promise.reject(new GitHubError('timeout', null)),
    };
    await expect(collectWindow(input(mostBroken))).rejects.toThrow(/could not read 2 of 3/);

    const limited = { ...base, pullRequest: () => Promise.reject(new GitHubRateLimitError(1)) };
    await expect(collectWindow(input(limited))).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it('passes the viewer login to the PR query', async () => {
    const base = fakeGitHub({ login: 'Me', prs: [reviewed] });
    const logins: string[] = [];
    const github = {
      ...base,
      pullRequest: (o: string, r: string, n: number, me: string) => {
        logins.push(me);
        return base.pullRequest(o, r, n, me);
      },
    };
    await collectWindow(input(github));
    expect(logins).toEqual(['Me']);
  });

  it('skips search results that are not repository URLs', async () => {
    const github = fakeGitHub({
      prs: [reviewed],
      search: () => [{ ...searchItem('x', 'y', 1), repository_url: 'nonsense' }],
    });
    expect((await collectWindow(input(github))).up).toEqual([]);
  });

  it('fetches PRs with exactly the configured concurrency', async () => {
    const prs = Array.from({ length: 9 }, (_, i) => pr({ number: i + 1, myReviews: [review()] }));
    const base = fakeGitHub({ prs });
    let active = 0;
    let peak = 0;
    const github = {
      ...base,
      pullRequest: async (o: string, r: string, n: number, me: string) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return base.pullRequest(o, r, n, me);
      },
    };
    const result = await collectWindow(input(github, { concurrency: 3 }));
    expect(peak).toBe(3);
    expect(result.up).toHaveLength(9);
  });
});
