/**
 * GitHub API client. Reads with the developer's own token, read-only. REST for search and
 * compare, GraphQL for one round trip per pull request: files with `viewerViewedState`, a light
 * list of every review, my own reviews with their comments, the timeline and the fork point.
 */
import type {
  Actor,
  ActorType,
  CompareFile,
  GitHubClient,
  PullRequestDetails,
  PullRequestFile,
  Review,
  ReviewComment,
  ReviewSummary,
  SearchPullRequest,
  Viewer,
} from './types.ts';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** The token is missing, expired or lacks the scopes. */
export class GitHubAuthError extends GitHubError {
  constructor(status: number) {
    super('GitHub rejected the token', status);
    this.name = 'GitHubAuthError';
  }
}

export class GitHubRateLimitError extends GitHubError {
  constructor(readonly resetAtMs: number | null) {
    super('GitHub rate limit reached', 429);
    this.name = 'GitHubRateLimitError';
  }
}

export interface GitHubClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** Search stops after this many pages of 100. GitHub caps search at 1,000 results anyway. */
  maxSearchPages?: number;
}

/** Under Chrome's 30 s limit for a fetch response in a service worker, so a slow PR is skipped. */
const REQUEST_TIMEOUT_MS = 25_000;
const PER_PAGE = 100;

/** Normalises a GitHub login for comparisons: lowercase, without the `[bot]` suffix. */
export function normalizeLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, '');
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const maxSearchPages = options.maxSearchPages ?? 10;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${options.token}`,
    'x-github-api-version': '2022-11-28',
  };

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GitHubError(
        `GitHub unreachable (${error instanceof Error ? error.message : String(error)})`,
        null,
      );
    }
    if (res.status === 401) throw new GitHubAuthError(res.status);
    const retryAfter = res.headers.get('retry-after');
    const exhausted = res.headers.get('x-ratelimit-remaining') === '0';
    if (res.status === 429 || (res.status === 403 && (exhausted || retryAfter !== null))) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const resetAtMs =
        retryAfter !== null && Number.isFinite(Number(retryAfter))
          ? Date.now() + Number(retryAfter) * 1000
          : Number.isFinite(reset) && reset > 0
            ? reset * 1000
            : null;
      throw new GitHubRateLimitError(resetAtMs);
    }
    return res;
  }

  /** GETs a REST resource. The caller asserts the shape of the body it reads. */
  async function rest(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`${apiBase}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await request(url.toString());
    if (!res.ok) {
      const hint = res.status === 403 ? ' (missing permission?)' : '';
      throw new GitHubError(`GitHub answered ${res.status}${hint}`, res.status);
    }
    return res.json();
  }

  /** POSTs a GraphQL query. The caller asserts the shape of the data it reads. */
  async function graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const res = await request(`${apiBase}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new GitHubError(`GitHub GraphQL answered ${res.status}`, res.status);
    const json = (await res.json()) as {
      data?: unknown;
      errors?: { message: string; type?: string }[];
    };
    if (json.errors?.length) {
      const messages = json.errors.map((e) => e.message).join('; ');
      // An exhausted GraphQL budget answers 200 with a RATE_LIMITED error.
      if (json.errors.some((e) => e.type === 'RATE_LIMITED')) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        throw new GitHubRateLimitError(Number.isFinite(reset) && reset > 0 ? reset * 1000 : null);
      }
      if (json.errors.some((e) => e.type === 'NOT_FOUND'))
        throw new GitHubError(`not found: ${messages}`, 404);
      throw new GitHubError(`GitHub GraphQL error: ${messages}`, res.status);
    }
    if (!json.data) throw new GitHubError('GitHub GraphQL answered without data', res.status);
    return json.data;
  }

  return {
    async viewer(): Promise<Viewer> {
      const body = (await rest('/user')) as { login: string };
      return { login: body.login };
    },

    async searchPullRequests(query: string): Promise<SearchPullRequest[]> {
      const items: SearchPullRequest[] = [];
      for (let page = 1; page <= maxSearchPages; page += 1) {
        const body = (await rest('/search/issues', {
          q: query,
          per_page: String(PER_PAGE),
          page: String(page),
          advanced_search: 'true',
        })) as { total_count: number; items: RawSearchItem[] };
        for (const item of body.items) {
          if (!item.pull_request) continue;
          items.push({
            number: item.number,
            repository_url: item.repository_url,
            draft: item.draft ?? false,
            updated_at: item.updated_at,
          });
        }
        if (body.items.length < PER_PAGE || page * PER_PAGE >= body.total_count) break;
      }
      return items;
    },

    async pullRequest(owner, repo, number, viewerLogin): Promise<PullRequestDetails> {
      const vars = { owner, name: repo, number, me: viewerLogin };
      const first = (await graphql(PR_QUERY, vars)) as {
        repository: { pullRequest: RawPullRequest | null } | null;
      };
      const raw = first.repository?.pullRequest;
      if (!raw) throw new GitHubError(`pull request not found`, 404);

      const files = [...raw.files.nodes];
      let filesPage = raw.files.pageInfo;
      while (filesPage.hasNextPage) {
        const more = (await graphql(FILES_QUERY, {
          owner,
          name: repo,
          number,
          after: filesPage.endCursor,
        })) as {
          repository: { pullRequest: { files: Connection<RawFile> } };
        };
        files.push(...more.repository.pullRequest.files.nodes);
        filesPage = more.repository.pullRequest.files.pageInfo;
      }

      const myReviews = [...raw.myReviews.nodes];
      let reviewsPage = raw.myReviews.pageInfo;
      while (reviewsPage.hasNextPage) {
        const more = (await graphql(MY_REVIEWS_QUERY, {
          ...vars,
          after: reviewsPage.endCursor,
        })) as {
          repository: { pullRequest: { myReviews: Connection<RawReview> } };
        };
        myReviews.push(...more.repository.pullRequest.myReviews.nodes);
        reviewsPage = more.repository.pullRequest.myReviews.pageInfo;
      }

      return {
        owner,
        repo,
        number: raw.number,
        state: raw.state,
        isDraft: raw.isDraft,
        author: toActor(raw.author),
        assignees: raw.assignees.nodes.map((a) => a.login),
        createdAt: raw.createdAt,
        closedAt: raw.closedAt,
        headRefOid: raw.headRefOid,
        baseRefOid: raw.baseRefOid,
        forkOid: raw.commits.nodes[0]?.commit.parents.nodes[0]?.oid ?? null,
        readyForReviewAt: raw.timelineItems.nodes.find((n) => n?.createdAt)?.createdAt ?? null,
        files: files.map(toFile),
        reviews: raw.reviews.nodes.map(toSummary),
        myReviews: myReviews.map(toReview),
      };
    },

    async compare(owner, repo, base, head): Promise<CompareFile[] | null> {
      // With a paging parameter GitHub lists the changed files on the first page only, up to
      // 300 files for the whole comparison. `per_page=1` keeps the commit list short.
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      try {
        const body = (await rest(path, { per_page: '1', page: '1' })) as { files?: CompareFile[] };
        return (body.files ?? []).map((f) => ({ filename: f.filename, changes: f.changes }));
      } catch (error) {
        if (error instanceof GitHubError && (error.status === 404 || error.status === 422)) {
          return null;
        }
        throw error;
      }
    },
  };
}

interface RawSearchItem {
  number: number;
  repository_url: string;
  draft?: boolean;
  updated_at: string;
  /** Present on pull requests, absent on issues. */
  pull_request?: unknown;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface Connection<T> {
  pageInfo: PageInfo;
  nodes: T[];
}

interface RawActor {
  login: string;
  __typename: string;
}

interface RawFile {
  path: string;
  additions: number;
  deletions: number;
  viewerViewedState: PullRequestFile['viewerViewedState'];
}

interface RawComment {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  replyTo: { id: string } | null;
}

interface RawReviewSummary {
  id: string;
  state: ReviewSummary['state'];
  submittedAt: string | null;
  author: RawActor | null;
}

interface RawReview extends RawReviewSummary {
  body: string;
  commit: { oid: string } | null;
  comments: { nodes: RawComment[] };
}

interface RawPullRequest {
  number: number;
  state: PullRequestDetails['state'];
  isDraft: boolean;
  createdAt: string;
  closedAt: string | null;
  headRefOid: string;
  baseRefOid: string;
  author: RawActor | null;
  assignees: { nodes: { login: string }[] };
  timelineItems: { nodes: ({ createdAt?: string } | null)[] };
  commits: { nodes: { commit: { parents: { nodes: { oid: string }[] } } }[] };
  files: Connection<RawFile>;
  reviews: { nodes: RawReviewSummary[] };
  myReviews: Connection<RawReview>;
}

const ACTOR_TYPES: ReadonlySet<string> = new Set<ActorType>([
  'User',
  'Bot',
  'Mannequin',
  'Organization',
  'EnterpriseUserAccount',
]);

function toActor(raw: RawActor | null): Actor | null {
  if (!raw) return null;
  const type = ACTOR_TYPES.has(raw.__typename) ? (raw.__typename as ActorType) : 'User';
  return { login: raw.login, type };
}

function toFile(raw: RawFile): PullRequestFile {
  return {
    path: raw.path,
    additions: raw.additions,
    deletions: raw.deletions,
    viewerViewedState: raw.viewerViewedState,
  };
}

function toSummary(raw: RawReviewSummary): ReviewSummary {
  return {
    id: raw.id,
    author: toActor(raw.author),
    state: raw.state,
    submittedAt: raw.submittedAt,
  };
}

function toReview(raw: RawReview): Review {
  const comments: ReviewComment[] = raw.comments.nodes.map((c) => ({
    id: c.id,
    path: c.path,
    line: c.line,
    startLine: c.startLine,
    originalLine: c.originalLine,
    originalStartLine: c.originalStartLine,
    isReply: c.replyTo !== null,
  }));
  return {
    ...toSummary(raw),
    commitOid: raw.commit?.oid ?? null,
    body: raw.body,
    comments,
  };
}

const FILE_FIELDS = `pageInfo { hasNextPage endCursor } nodes { path additions deletions viewerViewedState }`;
const MY_REVIEW_FIELDS = `pageInfo { hasNextPage endCursor } nodes {
  id state submittedAt body
  author { login __typename }
  commit { oid }
  comments(first: 100) { nodes { id path line startLine originalLine originalStartLine replyTo { id } } }
}`;

export const PR_QUERY = `query PullRequest($owner: String!, $name: String!, $number: Int!, $me: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number state isDraft createdAt closedAt headRefOid baseRefOid
      author { login __typename }
      assignees(first: 25) { nodes { login } }
      timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], last: 1) { nodes { ... on ReadyForReviewEvent { createdAt } } }
      commits(first: 1) { nodes { commit { parents(first: 1) { nodes { oid } } } } }
      files(first: 100) { ${FILE_FIELDS} }
      reviews(first: 100) { nodes { id state submittedAt author { login __typename } } }
      myReviews: reviews(first: 50, author: $me) { ${MY_REVIEW_FIELDS} }
    }
  }
}`;

export const FILES_QUERY = `query PullRequestFiles($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { files(first: 100, after: $after) { ${FILE_FIELDS} } } }
}`;

export const MY_REVIEWS_QUERY = `query PullRequestMyReviews($owner: String!, $name: String!, $number: Int!, $me: String!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { myReviews: reviews(first: 50, author: $me, after: $after) { ${MY_REVIEW_FIELDS} } } }
}`;
