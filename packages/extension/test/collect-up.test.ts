import { describe, expect, it } from 'vitest';

import { createClassifier } from '../src/lib/classify.ts';
import {
  COMMENT_RANGE_CAP,
  actionOf,
  commentLines,
  firstReviewId,
  upRecordsForPullRequest,
  type UpContext,
} from '../src/lib/collect/up.ts';
import type { CompareFile, PullRequestFile } from '../src/lib/github/types.ts';
import type { ViewedSnapshot } from '../src/lib/storage.ts';
import { NOW, comment, hoursAgo, pr, review, summary } from './helpers/github.ts';

const classify = createClassifier([{ name: 'test', globs: ['**/*.test.ts'] }]);

function file(path: string, lines: number, viewed = false): PullRequestFile {
  return {
    path,
    additions: lines,
    deletions: 0,
    viewerViewedState: viewed ? 'VIEWED' : 'UNVIEWED',
  };
}

function ctx(
  compare: (base: string, head: string) => CompareFile[] | null = () => [
    { filename: 'src/app.ts', changes: 400 },
  ],
  viewedSnapshots: Record<string, ViewedSnapshot> = {},
) {
  const calls: [string, string][] = [];
  const context: UpContext = {
    me: 'me',
    nowMs: NOW,
    classify,
    compare: (base, head) => {
      calls.push([base, head]);
      return Promise.resolve(compare(base, head));
    },
    viewedSnapshots,
  };
  return { context, calls };
}

describe('actionOf', () => {
  it('maps review states to the actions the formula weighs', () => {
    expect(actionOf(review({ state: 'APPROVED' }))).toBe('approve');
    expect(actionOf(review({ state: 'CHANGES_REQUESTED' }))).toBe('request_changes');
    expect(actionOf(review({ state: 'DISMISSED' }))).toBe('approve');
    expect(actionOf(review({ state: 'PENDING' }))).toBeNull();
  });

  it('tells a comment review from a thread reply', () => {
    expect(actionOf(review({ state: 'COMMENTED', body: 'Looks off' }))).toBe('comment');
    expect(actionOf(review({ state: 'COMMENTED', comments: [comment()] }))).toBe('comment');
    expect(actionOf(review({ state: 'COMMENTED', comments: [comment({ isReply: true })] }))).toBe(
      'thread_reply',
    );
    expect(
      actionOf(review({ state: 'COMMENTED', body: 'see', comments: [comment({ isReply: true })] })),
    ).toBe('comment');
    expect(actionOf(review({ state: 'COMMENTED', body: '  ' }))).toBeNull();
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

describe('firstReviewId', () => {
  it('skips bots, pending reviews and the owners of the PR', () => {
    const reviews = [
      summary({
        id: 'bot',
        author: { login: 'coderabbit', type: 'Bot' },
        submittedAt: hoursAgo(9),
      }),
      summary({ id: 'pending', state: 'PENDING', submittedAt: null }),
      summary({ id: 'owner', author: { login: 'Me', type: 'User' }, submittedAt: hoursAgo(8) }),
      summary({ id: 'later', submittedAt: hoursAgo(2) }),
      summary({ id: 'first', submittedAt: hoursAgo(5) }),
    ];
    expect(firstReviewId(reviews, new Set(['me']), 0)).toBe('first');
    expect(firstReviewId([], new Set(), 0)).toBeNull();
    // Reviews of the draft, before it was ready, do not count.
    expect(firstReviewId(reviews, new Set(['me']), Date.parse(hoursAgo(3)))).toBe('later');
  });
});

describe('upRecordsForPullRequest: covered lines', () => {
  it('credits my first review on the head with the full PR diff, without a compare call', async () => {
    const { context, calls } = ctx();
    const records = await upRecordsForPullRequest(
      pr({ myReviews: [review({ id: 'r1' })] }),
      context,
    );
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

  it('compares a first review of an older commit from the fork point, which survives a merge', async () => {
    const { context, calls } = ctx(() => [{ filename: 'src/app.ts', changes: 250 }]);
    const records = await upRecordsForPullRequest(
      pr({ state: 'MERGED', myReviews: [review({ commitOid: 'old' })] }),
      context,
    );
    expect(calls).toEqual([['fork', 'old']]);
    expect(records[0]!.linesByClass).toEqual({ production: 250 });
  });

  it('falls back to the base tip when GitHub gives no fork point', async () => {
    const { context, calls } = ctx();
    await upRecordsForPullRequest(
      pr({ forkOid: null, myReviews: [review({ commitOid: 'old' })] }),
      context,
    );
    expect(calls).toEqual([['base', 'old']]);
  });

  it('counts only PR files, each capped by its own diff, so "Update branch" is not reviewed code', async () => {
    // 300-line PR, changes requested at c1; the author merges main (5,000 lines elsewhere) and
    // fixes 5 lines; my approve covers those 5 lines.
    const { context, calls } = ctx((base) =>
      base === 'c1'
        ? [
            { filename: 'src/app.ts', changes: 5 },
            { filename: 'src/from-main.ts', changes: 5000 },
          ]
        : [{ filename: 'src/app.ts', changes: 300 }],
    );
    const records = await upRecordsForPullRequest(
      pr({
        files: [file('src/app.ts', 300)],
        myReviews: [
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
      ['fork', 'c1'],
      ['c1', 'head'],
    ]);
    expect(records.map((r) => r.linesByClass)).toEqual([{ production: 300 }, { production: 5 }]);
  });

  it('caps a file at its own diff in the PR', async () => {
    const { context } = ctx(() => [{ filename: 'src/app.ts', changes: 9000 }]);
    const records = await upRecordsForPullRequest(
      pr({
        myReviews: [
          review({ commitOid: 'c1', submittedAt: hoursAgo(5) }),
          review({ commitOid: 'head', submittedAt: hoursAgo(1) }),
        ],
      }),
      context,
    );
    expect(records[1]!.linesByClass).toEqual({ production: 400 });
  });

  it('falls back to the PR diff when GitHub cannot compare', async () => {
    const { context } = ctx(() => null);
    const records = await upRecordsForPullRequest(
      pr({ myReviews: [review({ commitOid: 'gone' })] }),
      context,
    );
    expect(records[0]!.linesByClass).toEqual({ production: 400 });
  });

  it('credits a commit once, to my strongest review on it: comment then approve equals approve', async () => {
    const { context } = ctx();
    const records = await upRecordsForPullRequest(
      pr({
        myReviews: [
          review({ id: 'c', submittedAt: hoursAgo(3), state: 'COMMENTED', comments: [comment()] }),
          review({ id: 'a', submittedAt: hoursAgo(1) }),
        ],
      }),
      context,
    );
    expect(records.map((r) => [r.reviewId, r.action, r.linesByClass])).toEqual([
      ['c', 'comment', {}],
      ['a', 'approve', { production: 400 }],
    ]);
    expect(records[0]!.commentedLinesByClass).toEqual({ production: 1 });
  });

  it('keeps the credit on an approval followed by a comment on the same commit', async () => {
    const { context } = ctx();
    const records = await upRecordsForPullRequest(
      pr({
        myReviews: [
          review({ id: 'a', submittedAt: hoursAgo(3) }),
          review({ id: 'c', submittedAt: hoursAgo(1), state: 'COMMENTED', body: 'nit' }),
        ],
      }),
      context,
    );
    expect(records.map((r) => r.linesByClass)).toEqual([{ production: 400 }, {}]);
  });

  it('gives a thread reply its commented lines only, and keeps the diff anchor', async () => {
    const { context, calls } = ctx();
    const records = await upRecordsForPullRequest(
      pr({
        myReviews: [
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
      ['fork', 'c1'],
      ['c1', 'head'],
    ]);
  });

  it('sums commented lines per class', async () => {
    const { context } = ctx();
    const records = await upRecordsForPullRequest(
      pr({
        myReviews: [
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
  });

  it('keeps an out-of-window review as the anchor of the next one, without reporting it', async () => {
    const { context, calls } = ctx();
    const records = await upRecordsForPullRequest(
      pr({
        myReviews: [
          review({ id: 'old', commitOid: 'c0', submittedAt: hoursAgo(200) }),
          review({ id: 'new', commitOid: 'head', submittedAt: hoursAgo(1) }),
        ],
      }),
      context,
    );
    expect(records.map((r) => r.reviewId)).toEqual(['new']);
    expect(calls).toEqual([['c0', 'head']]);
  });
});

describe('upRecordsForPullRequest: Viewed bonus', () => {
  it('counts the Viewed files of the credited range while its commit is the head, and snapshots them', async () => {
    const { context } = ctx();
    const details = pr({
      files: [file('src/app.ts', 400, true), file('a.test.ts', 20)],
      myReviews: [
        review({ id: 'r1', submittedAt: hoursAgo(2), state: 'COMMENTED', body: 'q' }),
        review({ id: 'r2', submittedAt: hoursAgo(1) }),
      ],
    });
    const records = await upRecordsForPullRequest(details, context);
    expect(records.map((r) => r.viewedLinesByClass)).toEqual([{}, { production: 400 }]);
    expect(context.viewedSnapshots['r2']).toEqual({
      linesByClass: { production: 400 },
      takenAt: NOW,
    });
    expect(context.viewedSnapshots['r1']).toBeUndefined();
  });

  it('is not earned again for unchanged files on a re-review', async () => {
    // 1,000-line PR, every file Viewed. The author pushes 10 lines to b.ts and I approve again:
    // the re-approval covers 10 lines and earns the Viewed bonus on those 10, not on 1,000.
    const { context } = ctx((base) =>
      base === 'c1'
        ? [{ filename: 'src/b.ts', changes: 10 }]
        : [{ filename: 'src/a.ts', changes: 990 }],
    );
    const records = await upRecordsForPullRequest(
      pr({
        files: [file('src/a.ts', 990, true), file('src/b.ts', 10, true)],
        myReviews: [
          review({ id: 'r1', commitOid: 'c1', submittedAt: hoursAgo(5) }),
          review({ id: 'r2', commitOid: 'head', submittedAt: hoursAgo(1) }),
        ],
      }),
      context,
    );
    expect(records[1]).toMatchObject({
      linesByClass: { production: 10 },
      viewedLinesByClass: { production: 10 },
    });
  });

  it('reuses the stored snapshot once the head moved, and has none otherwise', async () => {
    const { context } = ctx(() => [{ filename: 'src/app.ts', changes: 400 }], {
      r1: { linesByClass: { production: 120 }, takenAt: 0 },
    });
    const records = await upRecordsForPullRequest(
      pr({
        headRefOid: 'new-head',
        myReviews: [
          review({ id: 'r1', commitOid: 'c1', submittedAt: hoursAgo(2) }),
          review({ id: 'r9', commitOid: 'c9', submittedAt: hoursAgo(1) }),
        ],
      }),
      context,
    );
    expect(records.map((r) => r.viewedLinesByClass)).toEqual([{ production: 120 }, {}]);
  });
});

describe('upRecordsForPullRequest: rescue and ownership', () => {
  it('sets the wait only on the first human, non-owner review, from ready-for-review', async () => {
    const { context } = ctx();
    const mine = review({ id: 'mine', submittedAt: hoursAgo(20) });
    const details = pr({
      createdAt: hoursAgo(100),
      readyForReviewAt: hoursAgo(80),
      reviews: [
        summary({
          id: 'bot',
          author: { login: 'coderabbit', type: 'Bot' },
          submittedAt: hoursAgo(70),
        }),
        summary({
          id: 'self',
          author: { login: 'alice', type: 'User' },
          submittedAt: hoursAgo(60),
        }),
        summary({ id: 'mine', author: { login: 'me', type: 'User' }, submittedAt: hoursAgo(20) }),
      ],
      myReviews: [mine],
    });
    expect((await upRecordsForPullRequest(details, context))[0]!.waitedHoursWithoutReview).toBe(60);

    const later = await upRecordsForPullRequest(
      pr({
        reviews: [summary({ submittedAt: hoursAgo(5) })],
        myReviews: [review({ submittedAt: hoursAgo(1) })],
      }),
      context,
    );
    expect(later[0]!.waitedHoursWithoutReview).toBe(0);
  });

  it('earns nothing on PRs I own, including a github-actions PR assigned to me', async () => {
    const { context } = ctx();
    expect(
      await upRecordsForPullRequest(
        pr({ author: { login: 'Me', type: 'User' }, myReviews: [review()] }),
        context,
      ),
    ).toEqual([]);
    expect(
      await upRecordsForPullRequest(
        pr({
          author: { login: 'github-actions', type: 'Bot' },
          assignees: ['me'],
          myReviews: [review()],
        }),
        context,
      ),
    ).toEqual([]);
  });

  it("does not count the bot PR's assignee as the first reviewer of someone else's review", async () => {
    const { context } = ctx();
    const records = await upRecordsForPullRequest(
      pr({
        author: { login: 'github-actions', type: 'Bot' },
        assignees: ['carol'],
        createdAt: hoursAgo(60),
        reviews: [
          summary({
            id: 'carol',
            author: { login: 'carol', type: 'User' },
            submittedAt: hoursAgo(55),
          }),
          summary({ id: 'mine', author: { login: 'me', type: 'User' }, submittedAt: hoursAgo(1) }),
        ],
        myReviews: [review({ id: 'mine', submittedAt: hoursAgo(1) })],
      }),
      context,
    );
    expect(records[0]!.waitedHoursWithoutReview).toBe(59);
  });

  it('earns on a Dependabot PR like on any PR', async () => {
    const { context } = ctx();
    const records = await upRecordsForPullRequest(
      pr({ author: { login: 'dependabot', type: 'Bot' }, myReviews: [review()] }),
      context,
    );
    expect(records).toHaveLength(1);
  });

  it('ignores reviews of other people, pending reviews, and matches my login case-insensitively', async () => {
    const { context } = ctx();
    expect(
      await upRecordsForPullRequest(
        pr({ myReviews: [review({ author: { login: 'bob', type: 'User' } })] }),
        context,
      ),
    ).toEqual([]);
    expect(
      await upRecordsForPullRequest(
        pr({ myReviews: [review({ state: 'PENDING', submittedAt: null })] }),
        context,
      ),
    ).toEqual([]);
    expect(
      await upRecordsForPullRequest(
        pr({ myReviews: [review({ author: { login: 'ME', type: 'User' } })] }),
        context,
      ),
    ).toHaveLength(1);
  });
});

describe('upRecordsForPullRequest: second-review fixes', () => {
  it('keeps the credit on the first of two approvals of the same commit, so decay is not reset', async () => {
    const { context } = ctx();
    const records = await upRecordsForPullRequest(
      pr({
        createdAt: hoursAgo(160),
        myReviews: [
          review({ id: 'old', submittedAt: hoursAgo(150) }),
          review({ id: 'again', submittedAt: hoursAgo(1) }),
        ],
      }),
      context,
    );
    expect(records.map((r) => [r.reviewId, r.linesByClass])).toEqual([
      ['old', { production: 400 }],
      ['again', {}],
    ]);
  });

  it('moves the rescue with the credit: comment then approve equals approve', async () => {
    const waitedPr = (myReviews: ReturnType<typeof review>[]) =>
      pr({ createdAt: hoursAgo(80), myReviews });
    const direct = await upRecordsForPullRequest(
      waitedPr([review({ id: 'a', submittedAt: hoursAgo(8) })]),
      ctx().context,
    );
    const commentFirst = await upRecordsForPullRequest(
      waitedPr([
        review({ id: 'c', submittedAt: hoursAgo(8), state: 'COMMENTED', body: 'q' }),
        review({ id: 'a', submittedAt: hoursAgo(7) }),
      ]),
      ctx().context,
    );
    expect(direct[0]!.waitedHoursWithoutReview).toBe(72);
    expect(commentFirst.map((r) => [r.reviewId, r.waitedHoursWithoutReview])).toEqual([
      ['c', 0],
      ['a', 72],
    ]);
  });

  it('gives no rescue on a draft that was never marked ready', async () => {
    const records = await upRecordsForPullRequest(
      pr({
        isDraft: true,
        createdAt: hoursAgo(72),
        myReviews: [review({ state: 'COMMENTED', body: 'early thoughts' })],
      }),
      ctx().context,
    );
    expect(records[0]!.waitedHoursWithoutReview).toBe(0);
  });

  it('measures the wait from ready-for-review, ignoring earlier draft reviews', async () => {
    const records = await upRecordsForPullRequest(
      pr({
        createdAt: hoursAgo(200),
        readyForReviewAt: hoursAgo(60),
        reviews: [
          summary({
            id: 'draft-feedback',
            author: { login: 'bob', type: 'User' },
            submittedAt: hoursAgo(100),
          }),
          summary({ id: 'mine', author: { login: 'me', type: 'User' }, submittedAt: hoursAgo(5) }),
        ],
        myReviews: [review({ id: 'mine', submittedAt: hoursAgo(5) })],
      }),
      ctx().context,
    );
    expect(records[0]!.waitedHoursWithoutReview).toBe(55);
  });
});

describe('upRecordsForPullRequest: rescue and the draft lifecycle', () => {
  it('keeps the rescue on my post-ready review when the credit stayed on a draft review', async () => {
    // I approved the draft, the PR was marked ready, waited 60 h, then I approved the same commit.
    const records = await upRecordsForPullRequest(
      pr({
        createdAt: hoursAgo(200),
        readyForReviewAt: hoursAgo(100),
        myReviews: [
          review({ id: 'draft', submittedAt: hoursAgo(150) }),
          review({ id: 'ready', submittedAt: hoursAgo(40) }),
        ],
      }),
      ctx().context,
    );
    expect(records.map((r) => [r.reviewId, r.waitedHoursWithoutReview])).toEqual([
      ['draft', 0],
      ['ready', 60],
    ]);
    // The review made once the PR was ready also carries the covered lines: the rescue counts.
    expect(records.map((r) => [r.reviewId, r.linesByClass])).toEqual([
      ['draft', {}],
      ['ready', { production: 400 }],
    ]);
  });

  it('keeps an earned rescue when the PR is converted to draft afterwards', async () => {
    const records = await upRecordsForPullRequest(
      pr({
        isDraft: true,
        createdAt: hoursAgo(120),
        // Opened ready, converted to draft an hour ago.
        readyPeriods: [{ from: hoursAgo(120), to: hoursAgo(1) }],
        myReviews: [review({ submittedAt: hoursAgo(60) })],
      }),
      ctx().context,
    );
    expect(records[0]!.waitedHoursWithoutReview).toBe(60);
  });

  it('gives no rescue when someone reviewed during an earlier ready period', async () => {
    // Opened ready 120 h ago, reviewed by bob at 100 h, back to draft, ready again 60 h ago.
    const records = await upRecordsForPullRequest(
      pr({
        createdAt: hoursAgo(120),
        readyForReviewAt: hoursAgo(60),
        readyPeriods: [
          { from: hoursAgo(120), to: hoursAgo(90) },
          { from: hoursAgo(60), to: null },
        ],
        reviews: [
          summary({
            id: 'bob',
            author: { login: 'bob', type: 'User' },
            submittedAt: hoursAgo(100),
          }),
          summary({ id: 'mine', author: { login: 'me', type: 'User' }, submittedAt: hoursAgo(1) }),
        ],
        myReviews: [review({ id: 'mine', submittedAt: hoursAgo(1) })],
      }),
      ctx().context,
    );
    expect(records[0]!.waitedHoursWithoutReview).toBe(0);
  });
});

describe('upRecordsForPullRequest: waiting counts ready time only', () => {
  it('does not count a draft period as waiting', async () => {
    // Opened ready 74 h ago, converted to draft a minute later, ready again 2 h ago, reviewed now.
    const records = await upRecordsForPullRequest(
      pr({
        createdAt: hoursAgo(74),
        readyPeriods: [
          { from: hoursAgo(74), to: hoursAgo(74 - 1 / 60) },
          { from: hoursAgo(2), to: null },
        ],
        myReviews: [review({ submittedAt: hoursAgo(1) })],
      }),
      ctx().context,
    );
    expect(records[0]!.waitedHoursWithoutReview).toBeCloseTo(1 + 1 / 60, 5);
  });
});
