/**
 * GitHub App user access tokens: what github.com/login answers, and their renewal. A token from
 * the device flow renews with the app's public client ID alone, no client secret: GitHub answers
 * a new access token and a new refresh token, and the old refresh token stops working.
 *
 * These calls carry the refresh token in their body and get tokens back. The activity log keeps
 * neither (see `loggingFetch`), and nothing here logs them.
 */
import { GitHubError } from '../github/client.ts';

export const TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
/** Under Chrome's 30 s limit for a fetch in a service worker. */
export const LOGIN_TIMEOUT_MS = 15_000;

export interface AppTokens {
  accessToken: string;
  /** `null` when the app has expiring tokens turned off: the token then lasts until revoked. */
  accessTokenExpiresAt: number | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
}

/** GitHub no longer accepts the refresh token: expired, revoked, or already used. */
export class TokenRejectedError extends Error {
  constructor(readonly code: string) {
    super(`GitHub refused to renew the sign-in (${code})`);
    this.name = 'TokenRejectedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expiry(nowMs: number, seconds: unknown): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? nowMs + seconds * 1000
    : null;
}

/** The tokens in a successful answer of the token endpoint, or `null` when there are none. */
export function parseTokens(body: unknown, nowMs: number): AppTokens | null {
  if (!isRecord(body) || typeof body['access_token'] !== 'string' || !body['access_token']) {
    return null;
  }
  const refreshToken =
    typeof body['refresh_token'] === 'string' && body['refresh_token']
      ? body['refresh_token']
      : null;
  return {
    accessToken: body['access_token'],
    accessTokenExpiresAt: expiry(nowMs, body['expires_in']),
    refreshToken,
    refreshTokenExpiresAt: refreshToken ? expiry(nowMs, body['refresh_token_expires_in']) : null,
  };
}

/** POSTs a form to github.com/login and reads its JSON answer. */
export async function postLogin(
  fetchImpl: typeof fetch,
  url: string,
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { accept: 'application/json' },
    // A URLSearchParams body, never a string: the activity log keeps string bodies only.
    body: new URLSearchParams(form),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: an outage page. The status says enough.
  }
  return { status: res.status, body };
}

/**
 * Exchanges a refresh token for new tokens. Throws `TokenRejectedError` when GitHub refuses it,
 * and `GitHubError` when GitHub cannot be reached or fails: then the old tokens are still good.
 */
export async function renewTokens(options: {
  clientId: string;
  refreshToken: string;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<AppTokens> {
  let answer: { status: number; body: unknown };
  try {
    answer = await postLogin(options.fetchImpl, TOKEN_URL, {
      client_id: options.clientId,
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
    });
  } catch (error) {
    throw new GitHubError(
      `GitHub unreachable (${error instanceof Error ? error.message : String(error)})`,
      null,
    );
  }
  const { status, body } = answer;
  if (isRecord(body) && typeof body['error'] === 'string') {
    throw new TokenRejectedError(body['error']);
  }
  if (status >= 500 || status === 429) {
    throw new GitHubError(`GitHub answered ${status} to the token renewal`, status);
  }
  if (status >= 400) throw new TokenRejectedError(String(status));
  const tokens = parseTokens(body, options.now());
  if (!tokens) throw new GitHubError('GitHub answered the token renewal without a token', status);
  return tokens;
}
