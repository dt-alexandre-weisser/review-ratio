import { describe, expect, it } from 'vitest';

import { createClassifier } from '../src/lib/classify.ts';
import {
  COMMENT_RANGE_CAP,
  actionOf,
  commentLines,
  upRecordsForPullRequest,
  type UpContext,
} from '../src/lib/collect/up.ts';
import type { CompareFile } from '../src/lib/github/types.ts';
import type { ViewedSnapshot } from '../src/lib/storage.ts';
import { NOW, comment, hoursAgo, pr, review } from './helpers/github.ts';

const classify = createClassifier([{ name: 'test', globs: ['**/*.test.ts'] }]);

function ctx(
  overrides: Partial<UpContext> = {},
  compareResult: CompareFile[] | null = [{ filename: 'src/app.ts', changes: 400 }],
) {
  const calls: [string, string][] = [];
  const snapshots: Record<string, ViewedSnapshot> = {};
  const context: UpContext = {
    me: 'me',
    nowMs: NOW,
    classify,
    compare: (_o, _r, base, head) => {
      calls.push([base, head]);
      return Promise.resolve(compareResult);
    },
    viewedSnapshots: snapshots,
    ...overrides,
  };
  return { context, calls, snapshots: context.viewedSnapshots };
}

describe('actionOf', () => {
  it('maps review states to contract actions', () => {
    expect(actionOf(review({ state: 'APPROVED' }))).toBe('approve');
    expect(actionOf(review({ state: 'CHANGES_REQUESTED' }))).toBe('request_changes');
    expect(actionOf(review({ state: 'DISMISSED' }))).toBe('approve');
    expect(actionOf(review({ state: 'PENDING' }))).toBeNull();
  });

  it('tells a comment review from a thread reply', () => {
    expect(actionOf(review({ state: 'COMMENTED', body: 'Looks off', comments: [] }))).toBe(
      'comment',
    );
    expect(actionOf(review({ state: 'COMMENTED', comments: [comment()] }))).toBe('comment');
    expect(actionOf(review({ state: 'COMMENTED', comments: [comment({ isReply: true })] }))).toBe(
      'thread_reply',
    );
    expect(
      actionOf(review({ state: 'COMMENTED', body: 'see', comments: [comment({ isReply: true })] })),
    ).toBe('comment');
    expect(actionOf(review({ state: 'COMMENTED', body: '  ', comments: [] }))).toBeNull();
  });
});

describe('commentLines', () => {
  it('counts start_line..line, at least 1, capped at 20', () => {
    expect(commentLines(comment({ line: 10, startLine: null }))).toBe(1);
    expect(commentLines(comment({ line: 15, startLine: 10 }))).toBe(6);
    expect(commentLines(comment({ line: 100, startLine: 1 }))).toBe(COMMENT_RANGE_CAP);
  });

  it('falls back to the original lines on an outdated comment', () => {
    expect(
      commentLines(comment({ line: null, startLine: null, originalLine: 8, originalStartLine: 5 })),
    ).toBe(4);
    expect(
      commentLines(
        comment({ line: null, startLine: null, originalLine: null, originalStartLine: null }),
      ),
    ).toBe(1);
  });
});

describe('upRecordsForPullRequest', () => {
  it('credits my first review on the head with the full PR diff, without a compare call', async () => {
    const { context, calls } = ctx();
    const records = await upRecordsForPullRequest(pr({ reviews: [review({ id: 'r1' })] }), context);
    expect(calls).toEqual([]);
    expect(records).toEqual([
      {
        reviewId: 'r1',
        tMs: NOW - 3_600_000,
        action: 'approve',
        linesByClass: { production: 400 },
        commentedLinesByClass: {},
        viewedLinesByClass: {},
        waitedHoursWithoutReview: 9,
      },
    ]);
  });

  it('compares from the base on a first review of an older commit', async () => {
    const { context, calls } = ctx({}, [{ filename: 'a.test.ts', changes: 50 }]);
    const records = await upRecordsForPullRequest(
      pr({ reviews: [review({ commitOid: 'old' })] }),
      context,
    );
    expect(calls).toEqual([['base', 'old']]);
    expect(records[0]!.linesByClass).toEqual({ test: 50 });
  });

  it('credits a later review with the diff since my previous review, capped by the PR diff', async () => {
    const calls: [string, string][] = [];
    const { context } = ctx({
      compare: (_o, _r, base, head) => {
        calls.push([base, head]);
        // From the base: the PR's own changes at c1. From c1: a rebase dragged in 900 lines.
        return Promise.resolve(
          base === 'base'
            ? [{ filename: 'src/app.ts', changes: 250 }]
            : [
                { filename: 'src/app.ts', changes: 900 },
                { filename: 'a.test.ts', changes: 10 },
              ],
        );
      },
    });
    const records = await upRecordsForPullRequest(
      pr({
        reviews: [
          review({
            id: 'r1',
            commitOid: 'c1',
            submittedAt: hoursAgo(5),
            state: 'CHANGES_REQUESTED',
          }),
          review({ id: 'r2', commitOid: 'head', submittedAt: hoursAgo(1) }),
        ],
      }),
      context,
    );
    expect(calls).toEqual([
      ['base', 'c1'],
      ['c1', 'head'],
    ]);
    // 900 production lines are capped at the PR's 400; test lines are not in the PR at all.
    expect(records.map((r) => r.linesByClass)).toEqual([{ production: 250 }, { production: 400 }]);
  });

  it('gives nothing new for a second review on the same commit', async () => {
    const { context } = ctx();
    const records = await upRecordsForPullRequest(
      pr({
        reviews: [
          review({ id: 'r1', submittedAt: hoursAgo(3), state: 'COMMENTED', body: 'hm' }),
          review({ id: 'r2', submittedAt: hoursAgo(1) }),
        ],
      }),
      context,
    );
    expect(records.map((r) => r.linesByClass)).toEqual([{ production: 400 }, {}]);
  });

  it('falls back to the PR diff when GitHub cannot compare', async () => {
    const { context } = ctx({}, null);
    const records = await upRecordsForPullRequest(
      pr({ reviews: [review({ commitOid: 'gone' })] }),
      context,
    );
    expect(records[0]!.linesByClass).toEqual({ production: 400 });
  });

  it('gives a thread reply its commented lines only, and keeps the diff anchor', async () => {
    const { context, calls } = ctx();
    const records = await upRecordsForPullRequest(
      pr({
        reviews: [
          review({ id: 'r1', commitOid: 'c1', submittedAt: hoursAgo(5) }),
          review({
            id: 'reply',
            commitOid: 'c2',
            submittedAt: hoursAgo(3),
            state: 'COMMENTED',
            comments: [comment({ isReply: true, line: 4, startLine: 2 })],
          }),
          review({ id: 'r2', commitOid: 'head', submittedAt: hoursAgo(1) }),
        ],
      }),
      context,
    );
    expect(records.map((r) => r.action)).toEqual(['approve', 'thread_reply', 'approve']);
    expect(records[1]).toMatchObject({
      linesByClass: {},
      commentedLinesByClass: { production: 3 },
      viewedLinesByClass: {},
    });
    expect(calls).toEqual([
      ['base', 'c1'],
      ['c1', 'head'],
    ]);
  });

  it('sums commented lines per class', async () => {
    const { context } = ctx();
    const records = await upRecordsForPullRequest(
      pr({
        reviews: [
          review({
            state: 'COMMENTED',
            comments: [
              comment({ line: 3, startLine: 1 }),
              comment({ path: 'x.test.ts', line: 1 }),
              comment(),
            ],
          }),
        ],
      }),
      context,
    );
    expect(records[0]!.commentedLinesByClass).toEqual({ production: 4, test: 1 });
    expect(records[0]!.action).toBe('comment');
  });

  it('snapshots Viewed files while my review commit is the head, once per commit', async () => {
    const { context, snapshots } = ctx();
    const details = pr({
      files: [
        { path: 'src/app.ts', additions: 300, deletions: 100, viewerViewedState: 'VIEWED' },
        { path: 'a.test.ts', additions: 20, deletions: 0, viewerViewedState: 'UNVIEWED' },
      ],
      reviews: [
        review({ id: 'r1', submittedAt: hoursAgo(2), state: 'COMMENTED', body: 'q' }),
        review({ id: 'r2', submittedAt: hoursAgo(1) }),
      ],
    });
    const records = await upRecordsForPullRequest(details, context);
    expect(records.map((r) => r.viewedLinesByClass)).toEqual([{}, { production: 400 }]);
    expect(snapshots['r2']).toEqual({ linesByClass: { production: 400 }, takenAt: NOW });
    expect(snapshots['r1']).toBeUndefined();
  });

  it('reuses the stored snapshot once the head moved, and loses it when there is none', async () => {
    const stored: Record<string, ViewedSnapshot> = {
      r1: { linesByClass: { production: 120 }, takenAt: 0 },
    };
    const { context } = ctx({ viewedSnapshots: stored });
    const records = await upRecordsForPullRequest(
      pr({
        headRefOid: 'new-head',
        reviews: [
          review({ id: 'r1', commitOid: 'c1' }),
          review({ id: 'r9', commitOid: 'c9', submittedAt: hoursAgo(0.5) }),
        ],
      }),
      context,
    );
    expect(records.map((r) => r.viewedLinesByClass)).toEqual([{ production: 120 }, {}]);
  });

  it('sets the wait only on the first human review, from ready-for-review', async () => {
    const { context } = ctx();
    const details = pr({
      createdAt: hoursAgo(100),
      readyForReviewAt: hoursAgo(80),
      reviews: [
        review({
          id: 'bot',
          author: { login: 'coderabbit', type: 'Bot' },
          submittedAt: hoursAgo(70),
          state: 'COMMENTED',
          body: 'x',
        }),
        review({
          id: 'self',
          author: { login: 'alice', type: 'User' },
          submittedAt: hoursAgo(60),
          state: 'COMMENTED',
          body: 'x',
        }),
        review({ id: 'mine', submittedAt: hoursAgo(20) }),
      ],
    });
    const records = await upRecordsForPullRequest(details, context);
    expect(records[0]!.waitedHoursWithoutReview).toBe(60);

    const later = await upRecordsForPullRequest(
      pr({
        reviews: [
          review({ id: 'other', author: { login: 'bob', type: 'User' }, submittedAt: hoursAgo(5) }),
          review({ id: 'mine', submittedAt: hoursAgo(1) }),
        ],
      }),
      ctx().context,
    );
    expect(later[0]!.waitedHoursWithoutReview).toBe(0);
  });

  it('earns nothing on my own PRs, for other people, pending or out-of-window reviews', async () => {
    const { context, calls } = ctx();
    expect(
      await upRecordsForPullRequest(
        pr({ author: { login: 'Me', type: 'User' }, reviews: [review()] }),
        context,
      ),
    ).toEqual([]);
    expect(
      await upRecordsForPullRequest(
        pr({ reviews: [review({ author: { login: 'bob', type: 'User' } })] }),
        context,
      ),
    ).toEqual([]);
    expect(
      await upRecordsForPullRequest(
        pr({ reviews: [review({ state: 'PENDING', submittedAt: null })] }),
        context,
      ),
    ).toEqual([]);
    const old = await upRecordsForPullRequest(
      pr({
        reviews: [
          review({ id: 'old', commitOid: 'c0', submittedAt: hoursAgo(200) }),
          review({ id: 'new', commitOid: 'head', submittedAt: hoursAgo(1) }),
        ],
      }),
      context,
    );
    expect(old.map((r) => r.reviewId)).toEqual(['new']);
    // The out-of-window review still anchors the diff of the next one.
    expect(calls).toEqual([['c0', 'head']]);
  });

  it('earns on a bot PR like on any PR', async () => {
    const { context } = ctx();
    const records = await upRecordsForPullRequest(
      pr({ author: { login: 'dependabot', type: 'Bot' }, reviews: [review()] }),
      context,
    );
    expect(records).toHaveLength(1);
  });

  it('matches my login case-insensitively', async () => {
    const { context } = ctx();
    const records = await upRecordsForPullRequest(
      pr({ reviews: [review({ author: { login: 'ME', type: 'User' } })] }),
      context,
    );
    expect(records).toHaveLength(1);
  });
});
