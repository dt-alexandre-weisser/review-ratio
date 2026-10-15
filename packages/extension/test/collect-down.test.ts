import { describe, expect, it } from 'vitest';

import { createClassifier } from '../src/lib/classify.ts';
import {
  downRecordForPullRequest,
  isOwnedByMe,
  readyAtOf,
  type DownContext,
} from '../src/lib/collect/down.ts';
import { NOW, hoursAgo, pr } from './helpers/github.ts';

const ctx: DownContext = {
  me: 'me',
  nowMs: NOW,
  classify: createClassifier([]),
  prKeyOf: (owner, repo, number) => `key:${owner}/${repo}#${number}`,
};

describe('isOwnedByMe', () => {
  it('counts my PRs', () => {
    expect(isOwnedByMe(pr({ author: { login: 'Me', type: 'User' } }), 'me')).toBe(true);
    expect(isOwnedByMe(pr({ author: { login: 'alice', type: 'User' } }), 'me')).toBe(false);
    expect(isOwnedByMe(pr({ author: null }), 'me')).toBe(false);
  });

  it('counts a github-actions PR for its assignee only', () => {
    const bot = { login: 'github-actions', type: 'Bot' } as const;
    expect(isOwnedByMe(pr({ author: bot, assignees: ['ME'] }), 'me')).toBe(true);
    expect(isOwnedByMe(pr({ author: bot, assignees: ['bob'] }), 'me')).toBe(false);
    expect(
      isOwnedByMe(
        pr({ author: { login: 'github-actions[bot]', type: 'Bot' }, assignees: ['me'] }),
        'me',
      ),
    ).toBe(true);
  });

  it('counts a Dependabot PR for nobody', () => {
    expect(
      isOwnedByMe(pr({ author: { login: 'dependabot', type: 'Bot' }, assignees: ['me'] }), 'me'),
    ).toBe(false);
  });
});

describe('readyAtOf', () => {
  it('uses the last ready-for-review event, else the creation time', () => {
    expect(readyAtOf(pr({ createdAt: hoursAgo(50), readyForReviewAt: hoursAgo(10) }))).toBe(
      NOW - 10 * 3_600_000,
    );
    expect(readyAtOf(pr({ createdAt: hoursAgo(50), readyForReviewAt: null }))).toBe(
      NOW - 50 * 3_600_000,
    );
  });
});

describe('downRecordForPullRequest', () => {
  const mine = { author: { login: 'me', type: 'User' as const } };

  it('builds a record for my PR in review', () => {
    expect(downRecordForPullRequest(pr({ ...mine, readyForReviewAt: hoursAgo(5) }), ctx)).toEqual({
      prKey: 'key:DiliTrust/app#1',
      readyAtMs: NOW - 5 * 3_600_000,
      closedAtMs: null,
      linesByClass: { production: 400 },
    });
  });

  it('keeps counting a merged or closed PR in full', () => {
    const record = downRecordForPullRequest(
      pr({ ...mine, state: 'MERGED', closedAt: hoursAgo(2) }),
      ctx,
    );
    expect(record?.closedAtMs).toBe(NOW - 2 * 3_600_000);
  });

  it('ignores drafts, PRs older than 7 days of review, and PRs of others', () => {
    expect(downRecordForPullRequest(pr({ ...mine, isDraft: true }), ctx)).toBeNull();
    expect(downRecordForPullRequest(pr({ ...mine, createdAt: hoursAgo(168) }), ctx)).toBeNull();
    expect(downRecordForPullRequest(pr({ ...mine, createdAt: hoursAgo(167) }), ctx)).not.toBeNull();
    expect(downRecordForPullRequest(pr(), ctx)).toBeNull();
  });

  it('starts the clock at ready-for-review, so draft time does not count', () => {
    const record = downRecordForPullRequest(
      pr({ ...mine, createdAt: hoursAgo(300), readyForReviewAt: hoursAgo(20) }),
      ctx,
    );
    expect(record?.readyAtMs).toBe(NOW - 20 * 3_600_000);
  });
});
