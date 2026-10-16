/**
 * A fake GitHub for the end-to-end test: one PR by alice that I approved an hour ago, and one PR
 * of mine that became ready for review an hour ago. Both are 400 lines of production code, so the
 * anchor invariant says the badge must read ratio 1.00.
 */
import type { BrowserContext, Route } from '@playwright/test';

export const ME = 'dev-e2e';
const ORG = 'DiliTrust';
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

interface FakeReview {
  id: string;
  state: string;
  submittedAt: string;
  body: string;
  author: { login: string; __typename: string };
  commit: { oid: string };
  comments: { nodes: unknown[] };
}

function pullRequest(number: number, author: string, reviews: FakeReview[]) {
  return {
    number,
    state: 'OPEN',
    isDraft: false,
    createdAt: hourAgo(),
    closedAt: null,
    headRefOid: `head${number}`,
    baseRefOid: 'base',
    author: { login: author, __typename: 'User' },
    assignees: { nodes: [] },
    timelineItems: { nodes: [] },
    stateEvents: { nodes: [] },
    commits: { nodes: [{ commit: { parents: { nodes: [{ oid: 'fork' }] } } }] },
    files: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          path: 'src/secret-service/payments.ts',
          additions: 300,
          deletions: 100,
          viewerViewedState: 'UNVIEWED',
        },
      ],
    },
    reviews: {
      nodes: reviews.map(({ id, state, submittedAt, author: by }) => ({
        id,
        state,
        submittedAt,
        author: by,
      })),
    },
    myReviews: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: reviews.filter((r) => r.author.login === ME),
    },
  };
}

const PRS: Record<number, ReturnType<typeof pullRequest>> = {
  11: pullRequest(11, 'alice', [
    {
      id: 'PRR_e2e_1',
      state: 'APPROVED',
      submittedAt: hourAgo(),
      body: '',
      author: { login: ME, __typename: 'User' },
      commit: { oid: 'head11' },
      comments: { nodes: [] },
    },
  ]),
  22: pullRequest(22, ME, []),
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

export interface FakeGitHubOptions {
  /** Answer 401 to every API call. */
  rejectToken?: boolean;
  /**
   * The header of the pages: GitHub's AppHeader (default), a redesign with unknown classes but a
   * search button, or one with neither.
   */
  header?: 'app' | 'redesigned' | 'unknown';
  /** Serve pages without GitHub's signed-in signals. */
  signedOut?: boolean;
}

const ROW = 'display:flex;align-items:center;gap:8px';
const HEADERS = {
  app: `<header class="AppHeader" role="banner">
    <div class="AppHeader-globalBar" style="${ROW};justify-content:space-between;padding:12px">
      <div class="AppHeader-globalBar-start" style="${ROW}"><a href="/">logo</a><span class="AppHeader-context-full">DiliTrust / top-secret-repo</span></div>
      <div class="AppHeader-globalBar-end" style="${ROW}">
        <div class="AppHeader-search"><qbsearch-input><button class="header-search-button" aria-label="Search or jump to…">Type / to search</button></qbsearch-input></div>
        <div class="AppHeader-actions" style="${ROW}"><button>+</button><a href="/pulls">PRs</a></div>
        <a href="/notifications">inbox</a>
      </div>
    </div>
  </header>`,
  redesigned: `<header class="Nav2026" role="banner">
    <div class="Nav2026-row" style="${ROW};padding:12px">
      <a href="/">logo</a>
      <span class="Nav2026-searchWrap"><button aria-label="Search or jump to…">Type / to search</button></span>
      <button aria-label="Open Copilot">copilot</button>
    </div>
  </header>`,
  unknown: `<header class="GlobalNav" role="banner"><div class="GlobalNav-end" style="${ROW}"><a href="/notifications">bell</a></div></header>`,
};

export async function installFakeGitHub(context: BrowserContext, options: FakeGitHubOptions = {}) {
  await context.route('https://github.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>GitHub</title>
        ${options.signedOut ? '' : `<meta name="user-login" content="${ME}">`}
        </head><body class="${options.signedOut ? 'logged-out' : 'logged-in'}">
        ${HEADERS[options.header ?? 'app']}
        <main><h1>Fake GitHub</h1></main></body></html>`,
    }),
  );

  await context.route('https://api.github.com/**', async (route) => {
    if (options.rejectToken) return json(route, { message: 'Bad credentials' }, 401);
    const url = new URL(route.request().url());
    if (url.pathname === '/user') return json(route, { login: ME });
    if (url.pathname === `/orgs/${ORG}/repos`) return json(route, [{ id: 1, private: true }]);
    if (url.pathname === '/search/issues') {
      const q = url.searchParams.get('q') ?? '';
      const numbers = q.includes(`reviewed-by:${ME}`)
        ? [11]
        : q.includes(`author:${ME}`)
          ? [22]
          : [];
      return json(route, {
        total_count: numbers.length,
        items: numbers.map((n) => ({
          number: n,
          repository_url: `https://api.github.com/repos/${ORG}/top-secret-repo`,
          draft: false,
          updated_at: hourAgo(),
          pull_request: {},
        })),
      });
    }
    if (url.pathname === '/graphql') {
      const { variables } = route.request().postDataJSON() as { variables: { number: number } };
      return json(route, { data: { repository: { pullRequest: PRS[variables.number] ?? null } } });
    }
    return json(route, { message: 'Not Found' }, 404);
  });
}
