/**
 * The options page's connection test. Checks what a refresh needs, and says what is wrong in
 * words a developer can act on. A token that works but cannot see the organisation's private
 * repositories is the classic silent failure: the badge would read "no activity". With the
 * GitHub App, the same silence comes from an organisation that has not installed the app.
 *
 * It runs in the service worker, which owns the app tokens and renews them.
 */
import type { Settings } from './settings.ts';
import { WINDOW_MS, isoDate, localClock } from './time.ts';

export interface Diagnosis {
  ok: boolean;
  lines: string[];
}

/** In app mode: the signed-in token's expiry, and where the organisation installs the app. */
export interface AppDiagnosis {
  accessTokenExpiresAt: number | null;
  installUrl: string;
}

const TIMEOUT_MS = 15_000;

export async function diagnose(
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
  app: AppDiagnosis | null = null,
): Promise<Diagnosis> {
  const lines: string[] = [];
  let ok = true;
  const problem = (line: string) => {
    ok = false;
    lines.push(line);
  };

  const install = app ? ` An owner of ${settings.org} installs it here: ${app.installUrl}` : '';
  if (!settings.token) {
    problem(app ? 'GitHub: not signed in yet.' : 'GitHub: no token yet.');
  } else {
    const gh = (path: string) =>
      fetchImpl(`https://api.github.com${path}`, {
        headers: {
          authorization: `Bearer ${settings.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    try {
      const user = await gh('/user');
      if (!user.ok) {
        problem(
          app
            ? `GitHub: the sign-in was rejected (${user.status}). Sign out and sign in again.`
            : `GitHub: token rejected (${user.status}).`,
        );
      } else {
        const { login } = (await user.json()) as { login: string };
        const remaining = user.headers.get('x-ratelimit-remaining') ?? '?';
        if (app) {
          const until = app.accessTokenExpiresAt
            ? `, current token valid until ${localClock(app.accessTokenExpiresAt)} and renewed by itself`
            : '';
          lines.push(
            `GitHub: signed in as ${login} with the GitHub App${until} (${remaining} API calls left this hour).`,
          );
        } else {
          const expires = user.headers.get('github-authentication-token-expiration');
          lines.push(
            `GitHub: token works for ${login}${expires ? `, expires ${expires}` : ''} (${remaining} API calls left this hour).`,
          );
        }

        const installed = app ? await appInstalledOn(gh, settings.org) : true;
        const org = encodeURIComponent(settings.org);
        const repos = installed ? await gh(`/orgs/${org}/repos?type=private&per_page=1`) : null;
        if (repos === null) {
          problem(`GitHub: the review-ratio app is not installed on ${settings.org}.${install}`);
        } else if (repos.status === 404) {
          problem(`GitHub: organisation ${settings.org} not found, or not visible to this token.`);
        } else if (!repos.ok) {
          problem(
            `GitHub: cannot list ${settings.org} repositories (${repos.status}). Check the token permissions.`,
          );
        } else if (((await repos.json()) as unknown[]).length === 0) {
          problem(
            app
              ? `GitHub: the review-ratio app sees no private repository of ${settings.org}. Its installation may be limited to some repositories, none of them yours.${install}`
              : `GitHub: the token sees no private repository of ${settings.org}. Check that its resource owner is ${settings.org} and that the organisation approved it.`,
          );
        } else {
          const q = encodeURIComponent(
            `is:pr org:${settings.org} updated:>=${isoDate(nowMs - WINDOW_MS)}`,
          );
          const search = await gh(`/search/issues?q=${q}&per_page=1`);
          if (search.ok) {
            const { total_count } = (await search.json()) as { total_count: number };
            lines.push(
              `GitHub: ${total_count} pull requests of ${settings.org} updated in the last 7 days are visible.`,
            );
          }
        }
      }
    } catch (error) {
      problem(`GitHub: unreachable (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  return { ok, lines };
}

/**
 * Whether the app is installed on the organisation, from the installations the signed-in user can
 * reach. When GitHub cannot tell, the repository check below says what is visible.
 */
async function appInstalledOn(
  gh: (path: string) => Promise<Response>,
  org: string,
): Promise<boolean> {
  const res = await gh('/user/installations?per_page=100');
  if (!res.ok) return true;
  const body = (await res.json()) as { installations?: { account?: { login?: unknown } | null }[] };
  return (body.installations ?? []).some(
    (i) =>
      typeof i.account?.login === 'string' && i.account.login.toLowerCase() === org.toLowerCase(),
  );
}
