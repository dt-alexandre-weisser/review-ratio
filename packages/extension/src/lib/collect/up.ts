/**
 * ↑ side: the reviews I submitted on one pull request.
 *
 * Rules (DESIGN.md › Formula, Bot PRs, Viewed capture):
 * - My own PRs earn no ↑, whatever I post on them.
 * - Covered lines are the diff since the commit of my previous real review on the PR; the full
 *   diff on my first one. A thread reply is not a real review and does not move that anchor.
 * - A `COMMENTED` review with an empty body whose comments are all replies is a thread reply:
 *   it earns the commented-lines term only.
 * - Comment ranges are capped at 20 lines.
 * - The Viewed bonus goes to my latest real review on the current head, from a snapshot taken
 *   while that commit was still the head.
 * - `waitedHoursWithoutReview` is set when my review is the first non-bot, non-author review.
 */
import type { FileClass, LinesByClassV1, ReviewActionV1 } from '@review-ratio/contract';

import { linesByClass, type Classifier } from '../classify.ts';
import { normalizeLogin } from '../github/client.ts';
import type { GitHubClient, PullRequestDetails, Review } from '../github/types.ts';
import type { ViewedSnapshot } from '../storage.ts';
import { WINDOW_MS, hoursBetween, parseIso } from '../time.ts';
import type { UpInput } from './types.ts';

export const COMMENT_RANGE_CAP = 20;

export interface UpContext {
  /** My login, normalised. */
  me: string;
  nowMs: number;
  classify: Classifier;
  compare: GitHubClient['compare'];
  /** Existing snapshots. New ones are added to the returned map. */
  viewedSnapshots: Record<string, ViewedSnapshot>;
}

export function isBot(review: Review): boolean {
  return review.author?.type === 'Bot';
}

function isMine(review: Review, me: string): boolean {
  return review.author !== null && normalizeLogin(review.author.login) === me;
}

/** Maps a GitHub review to a contract action, or `null` when it earns nothing. */
export function actionOf(review: Review): ReviewActionV1 | null {
  switch (review.state) {
    case 'APPROVED':
      return 'approve';
    case 'CHANGES_REQUESTED':
      return 'request_changes';
    case 'DISMISSED':
      // Only approvals and change requests can be dismissed. The work was done.
      return 'approve';
    case 'COMMENTED': {
      if (review.comments.length === 0 && review.body.trim() === '') return null;
      const allReplies = review.comments.length > 0 && review.comments.every((c) => c.isReply);
      return review.body.trim() === '' && allReplies ? 'thread_reply' : 'comment';
    }
    case 'PENDING':
      return null;
  }
}

/** Lines of a comment range, `start_line..line`, capped. */
export function commentLines(comment: Review['comments'][number]): number {
  const end = comment.line ?? comment.originalLine;
  if (end === null) return 1;
  const start = comment.startLine ?? comment.originalStartLine ?? end;
  return Math.min(COMMENT_RANGE_CAP, Math.max(1, end - start + 1));
}

function firstReviewId(pr: PullRequestDetails): string | null {
  const author = pr.author ? normalizeLogin(pr.author.login) : null;
  let first: { id: string; at: number } | null = null;
  for (const review of pr.reviews) {
    if (review.state === 'PENDING' || review.submittedAt === null || isBot(review)) continue;
    if (author !== null && review.author && normalizeLogin(review.author.login) === author)
      continue;
    const at = parseIso(review.submittedAt);
    if (first === null || at < first.at) first = { id: review.id, at };
  }
  return first?.id ?? null;
}

function viewedLines(pr: PullRequestDetails, classify: Classifier): LinesByClassV1 {
  return linesByClass(
    pr.files
      .filter((f) => f.viewerViewedState === 'VIEWED')
      .map((f) => ({ path: f.path, lines: f.additions + f.deletions })),
    classify,
  );
}

export async function upRecordsForPullRequest(
  pr: PullRequestDetails,
  ctx: UpContext,
): Promise<UpInput[]> {
  if (pr.author && normalizeLogin(pr.author.login) === ctx.me) return [];

  const mine = pr.reviews
    .flatMap((review) => {
      const action = actionOf(review);
      if (!isMine(review, ctx.me) || review.submittedAt === null || action === null) return [];
      return [{ review, tMs: parseIso(review.submittedAt), action }];
    })
    .sort((a, b) => a.tMs - b.tMs);
  if (mine.length === 0) return [];

  const first = firstReviewId(pr);
  const readyAtMs = parseIso(pr.readyForReviewAt ?? pr.createdAt);
  const windowStart = ctx.nowMs - WINDOW_MS;

  // The latest real review per commit gets the Viewed bonus, so three reviews on one head do
  // not triple it.
  const latestRealByCommit = new Map<string, string>();
  for (const { review, action } of mine) {
    if (action !== 'thread_reply' && review.commitOid)
      latestRealByCommit.set(review.commitOid, review.id);
  }

  const records: UpInput[] = [];
  let previousRealCommit: string | null = null;
  for (const { review, tMs, action } of mine) {
    const inWindow = tMs >= windowStart;
    let covered: LinesByClassV1 = {};
    if (action !== 'thread_reply') {
      if (inWindow && review.commitOid) {
        covered = await coveredLines(pr, review.commitOid, previousRealCommit, ctx);
      }
      if (review.commitOid) previousRealCommit = review.commitOid;
    }
    if (!inWindow) continue;

    const commented = linesByClass(
      review.comments.map((c) => ({ path: c.path, lines: commentLines(c) })),
      ctx.classify,
    );

    let viewed: LinesByClassV1 = {};
    if (
      action !== 'thread_reply' &&
      review.commitOid &&
      latestRealByCommit.get(review.commitOid) === review.id
    ) {
      if (review.commitOid === pr.headRefOid) {
        viewed = viewedLines(pr, ctx.classify);
        ctx.viewedSnapshots[review.id] = { linesByClass: viewed, takenAt: ctx.nowMs };
      } else {
        viewed = ctx.viewedSnapshots[review.id]?.linesByClass ?? {};
      }
    }

    const waited = first === review.id ? Math.max(0, hoursBetween(readyAtMs, tMs)) : 0;

    records.push({
      reviewId: review.id,
      tMs,
      action,
      linesByClass: covered,
      commentedLinesByClass: commented,
      viewedLinesByClass: viewed,
      waitedHoursWithoutReview: waited,
    });
  }
  return records;
}

/** Lines of the PR's current diff, per class. */
function prLines(pr: PullRequestDetails, classify: Classifier): LinesByClassV1 {
  return linesByClass(
    pr.files.map((f) => ({ path: f.path, lines: f.additions + f.deletions })),
    classify,
  );
}

/** Per-class minimum. */
function capLines(lines: LinesByClassV1, cap: LinesByClassV1): LinesByClassV1 {
  const out: Partial<Record<FileClass, number>> = {};
  for (const [cls, n] of Object.entries(lines) as [FileClass, number | undefined][]) {
    const capped = Math.min(n ?? 0, cap[cls] ?? 0);
    if (capped > 0) out[cls] = capped;
  }
  return out;
}

/**
 * Lines I covered with a review on `commit`: the diff since my previous real review, or the
 * full PR diff on my first one.
 *
 * The incremental diff is capped per class by the PR's own diff. A three-dot compare between
 * two PR commits spans their merge base, so after the author rebases onto a newer base branch
 * it would also count the base branch's changes.
 */
async function coveredLines(
  pr: PullRequestDetails,
  commit: string,
  previousCommit: string | null,
  ctx: UpContext,
): Promise<LinesByClassV1> {
  if (previousCommit === commit) return {};
  const whole = prLines(pr, ctx.classify);
  if (previousCommit === null && commit === pr.headRefOid) return whole;

  const files = await ctx.compare(pr.owner, pr.repo, previousCommit ?? pr.baseRefOid, commit);
  // GitHub cannot compare any more (force-push, deleted commit): fall back to the PR's diff.
  if (files === null) return whole;
  const covered = linesByClass(
    files.map((f) => ({ path: f.filename, lines: f.changes })),
    ctx.classify,
  );
  return previousCommit === null ? covered : capLines(covered, whole);
}
