import { describe, expect, it } from 'vitest';

import { createClassifier } from '../src/lib/classify.ts';
import {
  collectWindow,
  parseRepositoryUrl,
  prRefKey,
  searchQueries,
} from '../src/lib/collect/index.ts';
import { NOW, fakeGitHub, hoursAgo, pr, review, searchItem } from './helpers/github.ts';

const classify = createClassifier([]);
let uuid = 0;
const randomUUID = () => `00000000-0000-4000-8000-${String((uuid += 1)).padStart(12, '0')}`;

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
});

describe('collectWindow', () => {
  const reviewed = pr({ number: 1, reviews: [review({ id: 'r1' })] });
  const own = pr({
    number: 2,
    author: { login: 'me', type: 'User' },
    readyForReviewAt: hoursAgo(3),
  });
  const excluded = pr({ repo: 'legacy', number: 3, reviews: [review({ id: 'r3' })] });

  it('collects ↑ and ↓ across PRs, deduplicated, skipping excluded repos', async () => {
    const github = fakeGitHub({ prs: [reviewed, own, excluded] });
    const result = await collectWindow({
      github,
      settings: { org: 'DiliTrust', excludedRepos: ['legacy'] },
      classify,
      nowMs: NOW,
      prKeys: {},
      viewedSnapshots: {},
      randomUUID,
    });
    expect(github.queries).toHaveLength(3);
    expect(result.up.map((r) => r.reviewId)).toEqual(['r1']);
    expect(result.down).toHaveLength(1);
    expect(Object.keys(result.prKeys)).toEqual(['dilitrust/app#2']);
    expect(result.prKeys['dilitrust/app#2']).toBe(result.down[0]!.prKey);
  });

  it('keeps existing PR keys and drops keys of PRs that left the window', async () => {
    const github = fakeGitHub({ prs: [own] });
    const result = await collectWindow({
      github,
      settings: { org: 'DiliTrust', excludedRepos: [] },
      classify,
      nowMs: NOW,
      prKeys: { 'dilitrust/app#2': 'kept-key', 'dilitrust/app#99': 'stale-key' },
      viewedSnapshots: {},
      randomUUID,
    });
    expect(result.prKeys).toEqual({ 'dilitrust/app#2': 'kept-key' });
    expect(result.down[0]!.prKey).toBe('kept-key');
  });

  it('keeps only the Viewed snapshots of reviews still in the window', async () => {
    const withViewed = pr({
      number: 5,
      files: [{ path: 'a.ts', additions: 10, deletions: 0, viewerViewedState: 'VIEWED' }],
      reviews: [review({ id: 'r5' })],
    });
    const github = fakeGitHub({ prs: [withViewed] });
    const result = await collectWindow({
      github,
      settings: { org: 'DiliTrust', excludedRepos: [] },
      classify,
      nowMs: NOW,
      prKeys: {},
      viewedSnapshots: { gone: { linesByClass: { production: 10 }, takenAt: 0 } },
      randomUUID,
    });
    expect(Object.keys(result.viewedSnapshots)).toEqual(['r5']);
  });

  it('skips search results that are not repository URLs', async () => {
    const github = fakeGitHub({
      prs: [reviewed],
      search: () => [{ ...searchItem('x', 'y', 1), repository_url: 'nonsense' }],
    });
    const result = await collectWindow({
      github,
      settings: { org: 'DiliTrust', excludedRepos: [] },
      classify,
      nowMs: NOW,
      prKeys: {},
      viewedSnapshots: {},
      randomUUID,
    });
    expect(result.up).toEqual([]);
  });

  it('fetches PRs with bounded concurrency', async () => {
    const prs = Array.from({ length: 9 }, (_, i) =>
      pr({ number: i + 1, reviews: [review({ id: `r${i}` })] }),
    );
    const base = fakeGitHub({ prs });
    let active = 0;
    let peak = 0;
    const github = {
      ...base,
      pullRequest: async (o: string, r: string, n: number) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return base.pullRequest(o, r, n);
      },
    };
    const result = await collectWindow({
      github,
      settings: { org: 'DiliTrust', excludedRepos: [] },
      classify,
      nowMs: NOW,
      prKeys: {},
      viewedSnapshots: {},
      randomUUID,
      concurrency: 3,
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(result.up).toHaveLength(9);
  });
});
