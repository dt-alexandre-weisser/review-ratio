/**
 * The options page's connection test. Checks what a refresh needs, and says what is wrong in
 * words a developer can act on. A token that works but cannot see the organisation's private
 * repositories is the classic silent failure: the badge would read "no activity".
 */
import { serverUrlProblem, type Settings } from './settings.ts';
import { WINDOW_MS, isoDate } from './time.ts';

export interface Diagnosis {
  ok: boolean;
  lines: string[];
}

const TIMEOUT_MS = 15_000;

export async function diagnose(
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<Diagnosis> {
  const lines: string[] = [];
  let ok = true;
  const problem = (line: string) => {
    ok = false;
    lines.push(line);
  };

  if (!settings.token) {
    problem('GitHub: no token yet.');
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
        problem(`GitHub: token rejected (${user.status}).`);
      } else {
        const { login } = (await user.json()) as { login: string };
        const expires = user.headers.get('github-authentication-token-expiration');
        const remaining = user.headers.get('x-ratelimit-remaining') ?? '?';
        lines.push(
          `GitHub: token works for ${login}${expires ? `, expires ${expires}` : ''} (${remaining} API calls left this hour).`,
        );

        const org = encodeURIComponent(settings.org);
        const repos = await gh(`/orgs/${org}/repos?type=private&per_page=1`);
        if (repos.status === 404) {
          problem(`GitHub: organisation ${settings.org} not found, or not visible to this token.`);
        } else if (!repos.ok) {
          problem(
            `GitHub: cannot list ${settings.org} repositories (${repos.status}). Check the token permissions.`,
          );
        } else if (((await repos.json()) as unknown[]).length === 0) {
          problem(
            `GitHub: the token sees no private repository of ${settings.org}. Check that its resource owner is ${settings.org} and that the organisation approved it.`,
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

  const urlProblem = serverUrlProblem(settings.serverUrl);
  if (urlProblem) {
    problem(`Server: ${urlProblem}.`);
  } else {
    try {
      const res = await fetchImpl(`${settings.serverUrl}/health`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        version?: string;
        contract?: { supported?: number[] };
      };
      if (res.ok && body.ok) {
        lines.push(
          `Server: ${settings.serverUrl} is up (v${body.version ?? '?'}, contract ${body.contract?.supported?.join(', ') ?? '?'}).`,
        );
      } else {
        problem(`Server: unexpected answer ${res.status} from ${settings.serverUrl}.`);
      }
    } catch (error) {
      problem(
        `Server: unreachable at ${settings.serverUrl} (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  return { ok, lines };
}
