/**
 * Collects the 7-day window from GitHub: every PR of the organisation I reviewed or own.
 */
import type { Classifier } from '../classify.ts';
import { normalizeLogin } from '../github/client.ts';
import type { GitHubClient, PullRequestDetails } from '../github/types.ts';
import { isExcludedRepo, type Settings } from '../settings.ts';
import type { ViewedSnapshot } from '../storage.ts';
import { WINDOW_MS, isoDate } from '../time.ts';
import { GITHUB_ACTIONS_LOGIN, downRecordForPullRequest } from './down.ts';
import type { DownInput, UpInput } from './types.ts';
import { upRecordsForPullRequest } from './up.ts';

export interface CollectInput {
  github: GitHubClient;
  settings: Pick<Settings, 'org' | 'excludedRepos'>;
  classify: Classifier;
  nowMs: number;
  prKeys: Record<string, string>;
  viewedSnapshots: Record<string, ViewedSnapshot>;
  randomUUID: () => string;
  /** How many PRs are fetched at once. */
  concurrency?: number;
}

export interface Collected {
  up: UpInput[];
  down: DownInput[];
  /** PR keys still in use. Keys of PRs that left the window are dropped. */
  prKeys: Record<string, string>;
  /** Snapshots still in use. */
  viewedSnapshots: Record<string, ViewedSnapshot>;
}

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export function prRefKey(ref: PullRequestRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
}

/** `https://api.github.com/repos/{owner}/{repo}` → `{ owner, repo }`. */
export function parseRepositoryUrl(url: string): { owner: string; repo: string } | null {
  const [, owner, repo] = /\/repos\/([^/]+)\/([^/]+)\/?$/.exec(url) ?? [];
  return owner && repo ? { owner, repo } : null;
}

export function searchQueries(org: string, me: string, nowMs: number): string[] {
  const since = isoDate(nowMs - WINDOW_MS);
  const scope = `is:pr org:${org} updated:>=${since}`;
  return [
    `${scope} reviewed-by:${me}`,
    `${scope} author:${me}`,
    `${scope} author:app/${GITHUB_ACTIONS_LOGIN} assignee:${me}`,
  ];
}

export async function collectWindow(input: CollectInput): Promise<Collected> {
  const me = normalizeLogin((await input.github.viewer()).login);
  const refs = new Map<string, PullRequestRef>();
  for (const query of searchQueries(input.settings.org, me, input.nowMs)) {
    for (const item of await input.github.searchPullRequests(query)) {
      const repo = parseRepositoryUrl(item.repository_url);
      if (!repo) continue;
      if (isExcludedRepo(input.settings, `${repo.owner}/${repo.repo}`)) continue;
      const ref = { ...repo, number: item.number };
      refs.set(prRefKey(ref), ref);
    }
  }

  const prKeys: Record<string, string> = {};
  const prKeyOf = (owner: string, repo: string, number: number): string => {
    const key = prRefKey({ owner, repo, number });
    const existing = input.prKeys[key] ?? prKeys[key] ?? input.randomUUID();
    prKeys[key] = existing;
    return existing;
  };
  const snapshots: Record<string, ViewedSnapshot> = { ...input.viewedSnapshots };

  const details = await mapWithConcurrency([...refs.values()], input.concurrency ?? 4, (ref) =>
    input.github.pullRequest(ref.owner, ref.repo, ref.number),
  );

  const up: UpInput[] = [];
  const down: DownInput[] = [];
  for (const pr of details) {
    up.push(
      ...(await upRecordsForPullRequest(pr, {
        me,
        nowMs: input.nowMs,
        classify: input.classify,
        compare: (o, r, b, h) => input.github.compare(o, r, b, h),
        viewedSnapshots: snapshots,
      })),
    );
    const record = downRecordForPullRequest(pr, {
      me,
      nowMs: input.nowMs,
      classify: input.classify,
      prKeyOf,
    });
    if (record) down.push(record);
  }

  const usedSnapshots: Record<string, ViewedSnapshot> = {};
  for (const record of up) {
    const snap = snapshots[record.reviewId];
    if (snap) usedSnapshots[record.reviewId] = snap;
  }

  return { up, down, prKeys, viewedSnapshots: usedSnapshots };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // One shared iterator: each worker takes the next item when it is free.
  const queue = items.entries();
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (const [index, item] of queue) {
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

export type { PullRequestDetails };
export type { DownInput, UpInput } from './types.ts';
