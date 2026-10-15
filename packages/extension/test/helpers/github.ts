import type {
  CompareFile,
  GitHubClient,
  PullRequestDetails,
  Review,
  ReviewComment,
  SearchPullRequest,
} from '../../src/lib/github/types.ts';

export const NOW = Date.parse('2026-10-15T12:00:00Z');
export const HOUR = 3_600_000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const hoursAgo = (h: number) => iso(NOW - h * HOUR);

export function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: `c${Math.random()}`,
    path: 'src/app.ts',
    line: 10,
    startLine: null,
    originalLine: 10,
    originalStartLine: null,
    isReply: false,
    ...overrides,
  };
}

export function review(overrides: Partial<Review> = {}): Review {
  return {
    id: `r${Math.random()}`,
    author: { login: 'me', type: 'User' },
    state: 'APPROVED',
    submittedAt: hoursAgo(1),
    commitOid: 'head',
    body: '',
    comments: [],
    ...overrides,
  };
}

export function pr(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
  return {
    owner: 'DiliTrust',
    repo: 'app',
    number: 1,
    state: 'OPEN',
    isDraft: false,
    author: { login: 'alice', type: 'User' },
    assignees: [],
    createdAt: hoursAgo(10),
    closedAt: null,
    headRefOid: 'head',
    baseRefOid: 'base',
    readyForReviewAt: null,
    files: [{ path: 'src/app.ts', additions: 300, deletions: 100, viewerViewedState: 'UNVIEWED' }],
    reviews: [],
    ...overrides,
  };
}

export function searchItem(owner: string, repo: string, number: number): SearchPullRequest {
  return {
    number,
    repository_url: `https://api.github.com/repos/${owner}/${repo}`,
    draft: false,
    updated_at: hoursAgo(1),
  };
}

export interface FakeGitHub extends GitHubClient {
  queries: string[];
  compares: [string, string][];
}

/** A GitHub client backed by in-memory PRs. Search returns PRs by query predicate. */
export function fakeGitHub(options: {
  login?: string;
  prs: PullRequestDetails[];
  search?: (query: string) => SearchPullRequest[];
  compare?: (base: string, head: string) => CompareFile[] | null;
}): FakeGitHub {
  const queries: string[] = [];
  const compares: [string, string][] = [];
  return {
    queries,
    compares,
    viewer: () => Promise.resolve({ login: options.login ?? 'me' }),
    searchPullRequests: (query) => {
      queries.push(query);
      return Promise.resolve(
        options.search?.(query) ?? options.prs.map((p) => searchItem(p.owner, p.repo, p.number)),
      );
    },
    pullRequest: (owner, repo, number) => {
      const found = options.prs.find(
        (p) => p.owner === owner && p.repo === repo && p.number === number,
      );
      return found ? Promise.resolve(found) : Promise.reject(new Error('not found'));
    },
    compare: (_o, _r, base, head) => {
      compares.push([base, head]);
      return Promise.resolve(
        options.compare ? options.compare(base, head) : [{ filename: 'src/app.ts', changes: 400 }],
      );
    },
  };
}
