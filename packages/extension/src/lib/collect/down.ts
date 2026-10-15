/**
 * ↓ side: one pull request I own, in review.
 *
 * Rules (DESIGN.md › Bot PRs, Time):
 * - A PR authored by me counts. A `github-actions` PR counts for its assignee. A Dependabot PR,
 *   or any other bot's, counts for nobody.
 * - Draft time does not count: the clock starts at the last ready-for-review event, or at
 *   creation when the PR was never a draft. A PR that is a draft now is not in review.
 * - The PR drops out at day 7, even if still open. Merged or closed PRs still count in full.
 */
import { linesByClass, type Classifier } from '../classify.ts';
import { normalizeLogin } from '../github/client.ts';
import type { PullRequestDetails } from '../github/types.ts';
import { WINDOW_MS, parseIso } from '../time.ts';
import type { DownInput } from './types.ts';

export const GITHUB_ACTIONS_LOGIN = 'github-actions';

export interface DownContext {
  me: string;
  nowMs: number;
  classify: Classifier;
  /** Returns the stored key of a PR or creates one. */
  prKeyOf: (owner: string, repo: string, number: number) => string;
}

/**
 * Normalised logins the PR counts as ↓ for: its human author, or the assignees of a
 * `github-actions` PR. Empty for any other bot.
 */
export function ownersOf(pr: PullRequestDetails): Set<string> {
  if (!pr.author) return new Set();
  const login = normalizeLogin(pr.author.login);
  if (pr.author.type !== 'Bot') return new Set([login]);
  if (login === GITHUB_ACTIONS_LOGIN) return new Set(pr.assignees.map(normalizeLogin));
  return new Set();
}

/** Whether the PR counts as asked by me. */
export function isOwnedByMe(pr: PullRequestDetails, me: string): boolean {
  return ownersOf(pr).has(me);
}

export function readyAtOf(pr: PullRequestDetails): number {
  return parseIso(pr.readyForReviewAt ?? pr.createdAt);
}

export function downRecordForPullRequest(
  pr: PullRequestDetails,
  ctx: DownContext,
): DownInput | null {
  if (!isOwnedByMe(pr, ctx.me)) return null;
  if (pr.isDraft) return null;
  const readyAtMs = readyAtOf(pr);
  if (ctx.nowMs - readyAtMs >= WINDOW_MS) return null;
  return {
    prKey: ctx.prKeyOf(pr.owner, pr.repo, pr.number),
    readyAtMs,
    closedAtMs: pr.closedAt === null ? null : parseIso(pr.closedAt),
    linesByClass: linesByClass(
      pr.files.map((f) => ({ path: f.path, lines: f.additions + f.deletions })),
      ctx.classify,
    ),
  };
}
