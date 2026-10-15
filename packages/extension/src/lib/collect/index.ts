/**
 * Collects the 7-day window from GitHub: every PR of the organisation I reviewed or own.
 *
 * One PR that GitHub cannot serve (deleted, transferred, timing out) is skipped, not fatal. The
 * refresh fails only on an auth or rate-limit error, or when most PRs fail, which points at
 * GitHub itself.
 */
import { ClassificationBudgetError, type Classifier } from '../classify.ts';
import {
  GitHubAuthError,
  GitHubError,
  GitHubRateLimitError,
  normalizeLogin,
} from '../github/client.ts';
import type { CompareFile, GitHubClient, PullRequestDetails } from '../github/types.ts';
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
  /** Compare results by `owner/repo:base...head`. Two SHAs always compare the same way. */
  compareCache: Record<string, CompareFile[]>;
  randomUUID: () => string;
  /** How many PRs are processed at once. */
  concurrency?: number;
}

export interface Collected {
  up: UpInput[];
  down: DownInput[];
  /** PR keys still in use. Keys of PRs that left the window are dropped. */
  prKeys: Record<string, string>;
  /** Snapshots taken within the window. */
  viewedSnapshots: Record<string, ViewedSnapshot>;
  /** Compare results used by this refresh. */
  compareCache: Record<string, CompareFile[]>;
  /** PRs that could not be read and were left out. */
  skipped: number;
  /** PRs read. */
  total: number;
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

/** Errors that mean the whole refresh cannot work: stop at once instead of skipping a PR. */
export function isFatal(error: unknown): boolean {
  return (
    error instanceof GitHubAuthError ||
    error instanceof GitHubRateLimitError ||
    error instanceof ClassificationBudgetError
  );
}

export async function collectWindow(input: CollectInput): Promise<Collected> {
  const login = (await input.github.viewer()).login;
  const me = normalizeLogin(login);
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
  const compareCache: Record<string, CompareFile[]> = {};

  const compareIn = (pr: PullRequestDetails) => async (base: string, head: string) => {
    const key = `${pr.owner}/${pr.repo}:${base}...${head}`.toLowerCase();
    const cached = compareCache[key] ?? input.compareCache[key];
    if (cached) {
      compareCache[key] = cached;
      return cached;
    }
    try {
      const files = await input.github.compare(pr.owner, pr.repo, base, head);
      if (files) compareCache[key] = files;
      return files;
    } catch (error) {
      if (isFatal(error)) throw error;
      // A 5xx or timeout on one comparison: fall back to the PR's own diff for that review.
      return null;
    }
  };

  const up: UpInput[] = [];
  const down: DownInput[] = [];
  const results = await mapWithConcurrency(
    [...refs.values()],
    input.concurrency ?? 4,
    async (ref) => {
      try {
        const pr = await input.github.pullRequest(ref.owner, ref.repo, ref.number, login);
        const ups = await upRecordsForPullRequest(pr, {
          me,
          nowMs: input.nowMs,
          classify: input.classify,
          compare: compareIn(pr),
          viewedSnapshots: snapshots,
        });
        const record = downRecordForPullRequest(pr, {
          me,
          nowMs: input.nowMs,
          classify: input.classify,
          prKeyOf,
        });
        return { ok: true as const, ups, record };
      } catch (error) {
        if (isFatal(error)) throw error;
        return { ok: false as const, error };
      }
    },
  );

  let skipped = 0;
  let lastError: unknown = null;
  for (const result of results) {
    if (!result.ok) {
      skipped += 1;
      lastError = result.error;
      continue;
    }
    up.push(...result.ups);
    if (result.record) down.push(result.record);
  }
  if (skipped > 0 && skipped * 2 > results.length) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new GitHubError(
      `could not read ${skipped} of ${results.length} pull requests (${reason})`,
      null,
    );
  }

  // Keep every snapshot still within the window, used or not: a PR skipped once (GitHub error)
  // must not lose the snapshot it can no longer retake after its head moved.
  const keptSnapshots: Record<string, ViewedSnapshot> = {};
  for (const [id, snap] of Object.entries(snapshots)) {
    if (input.nowMs - snap.takenAt < WINDOW_MS) keptSnapshots[id] = snap;
  }

  return {
    up,
    down,
    prKeys,
    viewedSnapshots: keptSnapshots,
    compareCache,
    skipped,
    total: results.length,
  };
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

export type { DownInput, UpInput } from './types.ts';
