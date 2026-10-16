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
   * The header of the pages: GitHub's React header of 2026 (default), the AppHeader of 2023–2025,
   * a redesign with unknown classes but a search button, or one with neither.
   */
  header?: 'globalnav' | 'app' | 'redesigned' | 'unknown';
  /** Serve pages without GitHub's signed-in signals. */
  signedOut?: boolean;
  /** Hide the header at first and show it after this long, as GitHub's search page does. */
  headerShowsAfterMs?: number;
  /**
   * Serve the header as GitHub does, server-rendered in a React partial, and mark its React commit
   * (hydration) after this long.
   */
  hydratesAfterMs?: number;
}

const ROW = 'display:flex;align-items:center;gap:8px';
/** GitHub's own rule: at 1,024 px and less the search box gives way to a search icon. */
const NARROW = `<style>
  .Search-module__smallSearchButton { display: none }
  @media (max-width: 1024px) {
    [class*="Search-module__searchButtonGroup"] { display: none !important }
    .Search-module__smallSearchButton { display: inline-block }
  }
</style>`;
const HEADERS = {
  // From an archived github.com page and GitHub's bundles, October 2026: Primer stacks, the search
  // box a button group (search, command palette) in the centre row.
  globalnav: `<header class="GlobalNav" aria-label="Global navigation menu" data-component="Stack">
    <div data-component="Stack" style="${ROW};justify-content:space-between;padding:12px">
      <div data-testid="top-nav-left" style="${ROW}"><button aria-label="Open menu">=</button><a aria-label="Dashboard" href="/">logo</a></div>
      <div data-testid="top-nav-center" style="${ROW};flex:1">
        <nav aria-label="Breadcrumbs"><a href="/DiliTrust">DiliTrust</a> / <a href="/DiliTrust/top-secret-repo">top-secret-repo</a></nav>
        <div class="Search-module__searchButtonGroup__aetw5" data-component="ButtonGroup" style="display:flex">
          <div><button class="Search-module__searchButton__aiE0a" aria-label="Open quick search dialog, type / to search" style="border-radius:6px 0 0 6px">Type / to search</button></div>
          <div><button aria-label="Command palette" style="border-radius:0 6px 6px 0">&gt;</button></div>
        </div>
        <button class="Search-module__smallSearchButton" aria-label="Open quick search dialog">search</button>
      </div>
      <div data-testid="top-nav-right" style="${ROW}"><button aria-label="Chat with Copilot">copilot</button><button>+</button><a href="/notifications">inbox</a></div>
    </div>
  </header>`,
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

function header(options: FakeGitHubOptions): string {
  const html = HEADERS[options.header ?? 'globalnav'];
  if (options.headerShowsAfterMs !== undefined) {
    return `<div id="late" style="display:none">${html}</div>
      <script>setTimeout(() => { document.getElementById('late').style.display = ''; }, ${options.headerShowsAfterMs});</script>`;
  }
  if (options.hydratesAfterMs !== undefined) {
    // window.swapHeader(ms) does what a Turbo visit does: a fresh server-rendered header replaces
    // the old one, and React commits it after ms.
    return `<react-partial partial-name="global-nav-bar" data-ssr="true">${html}</react-partial>
      <script>
        const commit = () => performance.mark('react-root:commit:global-nav-bar');
        setTimeout(commit, ${options.hydratesAfterMs});
        // As GitHub's Turbo does: turbo:before-render, the swap, then turbo:render after an await.
        // Records when the badge entered each new header and when React committed it.
        window.swaps = [];
        window.swapHeader = async (ms) => {
          document.dispatchEvent(new Event('turbo:before-render'));
          const old = document.querySelector('react-partial');
          const fresh = document.createElement('react-partial');
          fresh.setAttribute('partial-name', 'global-nav-bar');
          fresh.setAttribute('data-ssr', 'true');
          fresh.innerHTML = ${JSON.stringify(html)};
          const swap = { badgeAt: null, commitAt: null };
          window.swaps.push(swap);
          new MutationObserver((records, observer) => {
            if (fresh.querySelector('#review-ratio-badge')) {
              swap.badgeAt = performance.now();
              observer.disconnect();
            }
          }).observe(fresh, { childList: true, subtree: true });
          old.replaceWith(fresh);
          setTimeout(() => {
            commit();
            swap.commitAt = performance.now();
          }, ms);
          await new Promise((resolve) => setTimeout(resolve, 5));
          document.dispatchEvent(new Event('turbo:render'));
        };
      </script>`;
  }
  return html;
}

export async function installFakeGitHub(context: BrowserContext, options: FakeGitHubOptions = {}) {
  await context.route('https://github.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>GitHub</title>
        ${options.signedOut ? '' : `<meta name="user-login" content="${ME}">`}
        ${NARROW}
        </head><body class="${options.signedOut ? 'logged-out' : 'logged-in'}">
        ${header(options)}
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
