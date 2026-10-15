/**
 * ↑ side: the reviews I submitted on one pull request.
 *
 * Rules (DESIGN.md › Formula, Bot PRs, Viewed capture; docs/decisions.md):
 * - PRs I own (authored, or a github-actions PR assigned to me) earn no ↑.
 * - Covered lines are the diff since the commit of my previous real review, the full diff on my
 *   first one. They are counted per file, only for files of the PR, each capped by that file's
 *   own diff: a merge of the base branch into the PR never counts as reviewed code.
 * - Each reviewed commit range is credited once, to my strongest review on that commit
 *   (approve or request changes, else a comment review; the earliest among equals, so a second
 *   approval cannot restart the decay). Commenting first, then approving the same commit, is
 *   worth the same as approving: the credited review also takes the range's rescue.
 * - A `COMMENTED` review with an empty body whose comments are all replies is a thread reply:
 *   it earns the commented-lines term only and does not move the previous-review anchor.
 * - Comment ranges are capped at 20 lines.
 * - The Viewed bonus covers the files of the credited range that I marked Viewed, from a
 *   snapshot taken while that commit was still the PR head.
 * - `waitedHoursWithoutReview` is set when my review is the first review by a human who does
 *   not own the PR since it first became ready for review. The wait counts the time the PR was
 *   ready, not its draft periods; reviews of the draft before it first became ready do not count.
 *   An equally strong review made once the PR was ready takes a commit's credit from a review of
 *   the draft, and the rescue goes with that credit. When a stronger review of the draft keeps
 *   the credit, the rescue stays on the first review.
 */
import type { LinesByClassV1, ReviewActionV1 } from '@review-ratio/contract';

import { linesByClass, type Classifier } from '../classify.ts';
import { normalizeLogin } from '../github/client.ts';
import type { CompareFile, PullRequestDetails, Review, ReviewSummary } from '../github/types.ts';
import type { ViewedSnapshot } from '../storage.ts';
import { WINDOW_MS, hoursBetween, parseIso } from '../time.ts';
import { isOwnedByMe, ownersOf } from './down.ts';
import type { UpInput } from './types.ts';

export const COMMENT_RANGE_CAP = 20;

export interface UpContext {
  /** My login, normalised. */
  me: string;
  nowMs: number;
  classify: Classifier;
  /** Compares two commits of this PR's repository; `null` when GitHub cannot. */
  compare: (base: string, head: string) => Promise<CompareFile[] | null>;
  /** Existing snapshots. New ones are added to this map. */
  viewedSnapshots: Record<string, ViewedSnapshot>;
}

/** Lines per path. */
type FileLines = Map<string, number>;

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

/** A real review covers code; a thread reply only answers. */
function strength(action: ReviewActionV1): number {
  return action === 'approve' || action === 'request_changes' ? 2 : action === 'comment' ? 1 : 0;
}

/** Lines of a comment range, `start_line..line`, at least 1, capped. */
export function commentLines(comment: Review['comments'][number]): number {
  const end = comment.line ?? comment.originalLine;
  if (end === null) return 1;
  const start = comment.startLine ?? comment.originalStartLine ?? end;
  return Math.min(COMMENT_RANGE_CAP, Math.max(1, end - start + 1));
}

/**
 * The first review submitted from `readyAtMs` on by a human who does not own the PR. Reviews
 * of the draft are early feedback, not the review the PR was waiting for.
 */
export function firstReviewId(
  reviews: readonly ReviewSummary[],
  owners: ReadonlySet<string>,
  readyAtMs: number,
): string | null {
  let first: { id: string; at: number } | null = null;
  for (const review of reviews) {
    if (review.state === 'PENDING' || review.submittedAt === null) continue;
    if (!review.author || review.author.type === 'Bot') continue;
    if (owners.has(normalizeLogin(review.author.login))) continue;
    const at = parseIso(review.submittedAt);
    if (at < readyAtMs) continue;
    if (first === null || at < first.at) first = { id: review.id, at };
  }
  return first?.id ?? null;
}

function prFileLines(pr: PullRequestDetails): FileLines {
  return new Map(pr.files.map((f) => [f.path, f.additions + f.deletions]));
}

function classifyLines(lines: FileLines, classify: Classifier): LinesByClassV1 {
  return linesByClass(
    [...lines].map(([path, n]) => ({ path, lines: n })),
    classify,
  );
}

/**
 * Lines I covered with a review of `commit`, per file: the diff since `previous` (my previous
 * reviewed commit), or since the fork point on my first review. Only files of the PR count, each
 * capped by its own diff in the PR.
 */
async function coveredFiles(
  pr: PullRequestDetails,
  commit: string,
  previous: string | null,
  ctx: UpContext,
): Promise<FileLines> {
  const whole = prFileLines(pr);
  if (previous === null && commit === pr.headRefOid) return whole;
  const files = await ctx.compare(previous ?? pr.forkOid ?? pr.baseRefOid, commit);
  // GitHub cannot compare any more (force-push, deleted commit): fall back to the PR's diff.
  if (files === null) return whole;
  const covered: FileLines = new Map();
  for (const file of files) {
    const cap = whole.get(file.filename);
    if (cap === undefined) continue;
    const lines = Math.min((covered.get(file.filename) ?? 0) + file.changes, cap);
    if (lines > 0) covered.set(file.filename, lines);
  }
  return covered;
}

interface Mine {
  review: Review;
  tMs: number;
  action: ReviewActionV1;
}

interface Range {
  commit: string;
  previous: string | null;
  /** The review that gets the covered lines, the Viewed bonus and the rescue of this range. */
  credited: Mine;
  /** Every real review of mine on this commit. */
  members: Set<string>;
}

/**
 * Groups my real reviews by reviewed commit, in order, and picks the review credited for each:
 * the strongest; among equals the earliest, except that a review made once the PR was ready
 * takes the credit from one made of the draft.
 */
function rangesOf(mine: readonly Mine[], firstReadyMs: number | null): Range[] {
  const ofDraft = (entry: Mine) => firstReadyMs === null || entry.tMs < firstReadyMs;
  const ranges = new Map<string, Range>();
  let previous: string | null = null;
  for (const entry of mine) {
    const commit = entry.review.commitOid;
    if (strength(entry.action) === 0 || commit === null) continue;
    const range = ranges.get(commit);
    if (!range) {
      ranges.set(commit, {
        commit,
        previous,
        credited: entry,
        members: new Set([entry.review.id]),
      });
      previous = commit;
    } else {
      range.members.add(entry.review.id);
      const stronger = strength(entry.action) > strength(range.credited.action);
      const equalButReady =
        strength(entry.action) === strength(range.credited.action) &&
        ofDraft(range.credited) &&
        !ofDraft(entry);
      // Among equals the earliest keeps the credit and its age: re-approving restarts no decay.
      if (stronger || equalButReady) range.credited = entry;
    }
  }
  return [...ranges.values()];
}

function firstReadyMsOf(pr: PullRequestDetails): number | null {
  const first = pr.readyPeriods[0];
  return first ? parseIso(first.from) : null;
}

/** Hours the PR spent ready for review before `untilMs`. */
export function readyHoursBefore(pr: PullRequestDetails, untilMs: number): number {
  let ms = 0;
  for (const period of pr.readyPeriods) {
    const from = parseIso(period.from);
    const to = Math.min(period.to === null ? untilMs : parseIso(period.to), untilMs);
    if (to > from) ms += to - from;
  }
  return hoursBetween(0, ms);
}

/** The first review since the PR first became ready, and how long the PR waited for it. */
function rescueOf(
  pr: PullRequestDetails,
): { id: string; atMs: number; waitedHours: number } | null {
  const readyMs = firstReadyMsOf(pr);
  if (readyMs === null) return null;
  const id = firstReviewId(pr.reviews, ownersOf(pr), readyMs);
  const at = pr.reviews.find((r) => r.id === id)?.submittedAt;
  if (id === null || !at) return null;
  const atMs = parseIso(at);
  return { id, atMs, waitedHours: readyHoursBefore(pr, atMs) };
}

export async function upRecordsForPullRequest(
  pr: PullRequestDetails,
  ctx: UpContext,
): Promise<UpInput[]> {
  if (isOwnedByMe(pr, ctx.me)) return [];

  const mine: Mine[] = pr.myReviews
    .flatMap((review) => {
      const action = actionOf(review);
      if (!review.author || normalizeLogin(review.author.login) !== ctx.me) return [];
      if (review.submittedAt === null || action === null) return [];
      return [{ review, tMs: parseIso(review.submittedAt), action }];
    })
    .sort((a, b) => a.tMs - b.tMs);
  if (mine.length === 0) return [];

  const windowStart = ctx.nowMs - WINDOW_MS;
  const allRanges = rangesOf(mine, firstReadyMsOf(pr));
  const ranges = allRanges.filter((r) => r.credited.tMs >= windowStart);
  const coveredByReview = new Map<string, FileLines>(
    await Promise.all(
      ranges.map(
        async (r) =>
          [r.credited.review.id, await coveredFiles(pr, r.commit, r.previous, ctx)] as const,
      ),
    ),
  );

  // When the first review is one of mine on a reviewed commit, the rescue goes with that
  // range's credit, provided the credited review is not an earlier review of the draft.
  const rescue = rescueOf(pr);
  const creditedForRescue = allRanges.find(
    (r) => rescue !== null && r.members.has(rescue.id),
  )?.credited;
  const rescuedId =
    creditedForRescue && rescue && creditedForRescue.tMs >= rescue.atMs
      ? creditedForRescue.review.id
      : (rescue?.id ?? null);

  const viewedNow = new Set(
    pr.files.filter((f) => f.viewerViewedState === 'VIEWED').map((f) => f.path),
  );

  const records: UpInput[] = [];
  for (const { review, tMs, action } of mine) {
    if (tMs < windowStart) continue;
    const covered = coveredByReview.get(review.id);

    let viewed: LinesByClassV1 = {};
    if (covered) {
      if (review.commitOid === pr.headRefOid) {
        viewed = classifyLines(
          new Map([...covered].filter(([path]) => viewedNow.has(path))),
          ctx.classify,
        );
        ctx.viewedSnapshots[review.id] = { linesByClass: viewed, takenAt: ctx.nowMs };
      } else {
        viewed = ctx.viewedSnapshots[review.id]?.linesByClass ?? {};
      }
    }

    records.push({
      reviewId: review.id,
      tMs,
      action,
      linesByClass: covered ? classifyLines(covered, ctx.classify) : {},
      commentedLinesByClass: linesByClass(
        review.comments.map((c) => ({ path: c.path, lines: commentLines(c) })),
        ctx.classify,
      ),
      viewedLinesByClass: viewed,
      waitedHoursWithoutReview: rescue !== null && rescuedId === review.id ? rescue.waitedHours : 0,
    });
  }
  return records;
}
