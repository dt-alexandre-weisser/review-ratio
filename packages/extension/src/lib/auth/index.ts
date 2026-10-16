/**
 * Where GitHub tokens come from. Two modes, chosen in the options page:
 *
 * - `pat`: a fine-grained personal access token the developer pasted. Used as is.
 * - `app`: a GitHub App user access token from the device flow. It expires after 8 hours; it is
 *   renewed shortly before, or once when GitHub answers 401, with the refresh token.
 *
 * Only the service worker uses this: renewals rotate the refresh token, so one context must own
 * them. A renewal GitHub refuses (refresh token expired or revoked) signs the developer out, and
 * the badge goes back to "set up".
 */
import type { Store } from '../storage.ts';
import { TokenRejectedError, renewTokens, type AppTokens } from './tokens.ts';

/** Renew this long before the access token expires, so no call starts with a dying token. */
export const RENEW_MARGIN_MS = 5 * 60 * 1000;

/** What the GitHub client needs: a token per call, and another one after a 401. */
export interface TokenSource {
  /** The token to call GitHub with, renewed first when it is about to expire; `null` when none. */
  getAccessToken(): Promise<string | null>;
  /**
   * GitHub answered 401 to `rejected`. Returns a different token to retry with once, or `null`.
   * Throws `GitHubError` when the renewal could not reach GitHub.
   */
  renewAfterUnauthorized(rejected: string): Promise<string | null>;
  /** Whether a credential is configured, without any call. */
  hasCredential(): Promise<boolean>;
}

export interface Auth extends TokenSource {
  /** Stores the tokens of a finished device flow and switches to app mode, dropping the PAT. */
  completeSignIn(tokens: AppTokens, login: string | null): Promise<void>;
  /** Forgets the app tokens. A renewal in flight cannot write them back. */
  signOut(): Promise<void>;
}

export interface AuthDeps {
  store: Store;
  fetchImpl: typeof fetch;
  now: () => number;
  clientId: string;
  log?: (message: string) => void;
}

export function createAuth(deps: AuthDeps): Auth {
  const { store } = deps;
  let renewing: Promise<string | null> | null = null;
  /** Bumped by each sign-in and sign-out: a renewal that started before writes nothing. */
  let generation = 0;

  async function clear(reason: string): Promise<void> {
    await store.clearAppAuth();
    deps.log?.(`signed out of GitHub: ${reason}`);
  }

  async function doRenew(rejected: string, unauthorized: boolean): Promise<string | null> {
    const started = generation;
    const creds = await store.getAppAuth();
    if (!creds) return null;
    // Another caller renewed it in the meantime.
    if (creds.accessToken !== rejected) return creds.accessToken;
    const nowMs = deps.now();
    if (
      !creds.refreshToken ||
      (creds.refreshTokenExpiresAt !== null && nowMs >= creds.refreshTokenExpiresAt)
    ) {
      // Without expiring tokens there is nothing to renew: a 401 means the token was revoked.
      if (!unauthorized && creds.accessTokenExpiresAt === null) return creds.accessToken;
      await clear('the sign-in expired');
      return null;
    }
    let tokens: AppTokens;
    try {
      tokens = await renewTokens({
        clientId: deps.clientId,
        refreshToken: creds.refreshToken,
        fetchImpl: deps.fetchImpl,
        now: deps.now,
      });
    } catch (error) {
      if (started !== generation) return null;
      if (error instanceof TokenRejectedError) {
        await clear(`GitHub refused to renew it (${error.code})`);
        return null;
      }
      // GitHub unreachable: the current token serves until it actually expires.
      const stillValid =
        creds.accessTokenExpiresAt === null || deps.now() < creds.accessTokenExpiresAt;
      if (!unauthorized && stillValid) return creds.accessToken;
      throw error;
    }
    // Signed out, or in again, while GitHub answered: those tokens win.
    if (started !== generation) return (await store.getAppAuth())?.accessToken ?? null;
    await store.setAppAuth({ ...tokens, login: creds.login });
    deps.log?.('renewed the GitHub sign-in');
    return tokens.accessToken;
  }

  /** One renewal at a time: concurrent callers share it, and the refresh token is used once. */
  function renew(rejected: string, unauthorized: boolean): Promise<string | null> {
    renewing ??= doRenew(rejected, unauthorized).finally(() => {
      renewing = null;
    });
    return renewing;
  }

  return {
    async getAccessToken() {
      const settings = await store.getSettings();
      if (settings.authMode === 'pat') return settings.token || null;
      if (renewing) return renewing;
      const creds = await store.getAppAuth();
      if (!creds) return null;
      if (
        creds.accessTokenExpiresAt === null ||
        deps.now() < creds.accessTokenExpiresAt - RENEW_MARGIN_MS
      ) {
        return creds.accessToken;
      }
      return renew(creds.accessToken, false);
    },

    async renewAfterUnauthorized(rejected) {
      const settings = await store.getSettings();
      if (settings.authMode === 'pat') return null;
      const token = await renew(rejected, true);
      return token === rejected ? null : token;
    },

    async hasCredential() {
      const settings = await store.getSettings();
      if (settings.authMode === 'pat') return Boolean(settings.token);
      return (await store.getAppAuth()) !== null;
    },

    async completeSignIn(tokens, login) {
      generation += 1;
      await store.setAppAuth({ ...tokens, login });
      await store.setSettings({ ...(await store.getSettings()), authMode: 'app', token: '' });
      deps.log?.(`signed in to GitHub${login ? ` as ${login}` : ''} with the GitHub App`);
    },

    async signOut() {
      generation += 1;
      if ((await store.getAppAuth()) === null) return;
      await clear('signed out on the options page');
    },
  };
}
