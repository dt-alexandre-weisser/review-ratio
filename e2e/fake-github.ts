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
    firstStateEvent: { nodes: [] },
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
}

export async function installFakeGitHub(context: BrowserContext, options: FakeGitHubOptions = {}) {
  await context.route('https://github.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>GitHub</title></head><body>
        <header class="AppHeader"><div class="AppHeader-globalBar"><div class="AppHeader-globalBar-end"><button>bell</button></div></div></header>
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
