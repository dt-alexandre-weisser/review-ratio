/**
 * "Sign in with GitHub", run by the service worker for the options page: one device flow at a
 * time, polled in the background so that closing the options page does not stop it.
 *
 * The device code stays in this worker's memory. What the options page sees (the code to type,
 * the state) is published to `chrome.storage.session`, which content scripts cannot read; the
 * page then asks for the full status. If the worker stops mid-flow, the status reads idle and the
 * page asks to sign in again.
 */
import type { AuthMode } from '../settings.ts';
import type { Store } from '../storage.ts';
import { installUrl, isAppConfigured } from './app-config.ts';
import {
  DeviceFlowError,
  pollForTokens,
  requestDeviceCode,
  sleep as defaultSleep,
} from './device-flow.ts';
import type { Auth } from './index.ts';
import { LOGIN_TIMEOUT_MS } from './tokens.ts';

export type FlowView =
  | { state: 'idle' }
  /** Waiting for the developer to type `userCode` at `verificationUri`. */
  | { state: 'waiting'; userCode: string; verificationUri: string; expiresAt: number }
  | { state: 'signed_in'; login: string | null }
  | { state: 'failed'; message: string };

export interface AuthStatus {
  /** Whether this build has a GitHub App to sign in with. */
  appConfigured: boolean;
  installUrl: string;
  mode: AuthMode;
  /** The app sign-in, when there is one. */
  signedIn: { login: string | null; accessTokenExpiresAt: number | null } | null;
  flow: FlowView;
}

/** The `chrome.storage.session` key the flow view is published under. */
export const FLOW_KEY = 'authFlow';

export interface SignInDeps {
  auth: Auth;
  store: Store;
  fetchImpl: typeof fetch;
  now: () => number;
  clientId: string;
  slug: string;
  publish: (view: FlowView) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Keeps the worker alive while it polls; returns what stops it. */
  keepAlive?: () => () => void;
  log?: (message: string) => void;
}

export interface SignIn {
  status(): Promise<AuthStatus>;
  /** Asks GitHub for a code and starts polling. Resolves once the code is shown. */
  start(): Promise<AuthStatus>;
  cancel(): Promise<AuthStatus>;
  signOut(): Promise<AuthStatus>;
  /** The polling in progress, for tests. */
  settled(): Promise<void>;
}

/** The login of a fresh token, for the options page. `null` when GitHub does not say. */
async function fetchLogin(fetchImpl: typeof fetch, token: string): Promise<string | null> {
  try {
    const res = await fetchImpl('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const { login } = (await res.json()) as { login?: unknown };
    return typeof login === 'string' ? login : null;
  } catch {
    return null;
  }
}

export function createSignIn(deps: SignInDeps): SignIn {
  let view: FlowView = { state: 'idle' };
  let flow: { controller: AbortController; done: Promise<void> } | null = null;

  async function show(next: FlowView): Promise<void> {
    view = next;
    await deps.publish(next);
  }

  function stopFlow(): void {
    flow?.controller.abort();
    flow = null;
  }

  async function status(): Promise<AuthStatus> {
    const settings = await deps.store.getSettings();
    const creds = await deps.store.getAppAuth();
    return {
      appConfigured: isAppConfigured(deps.clientId, deps.slug),
      installUrl: installUrl(deps.slug),
      mode: settings.authMode,
      signedIn: creds
        ? { login: creds.login, accessTokenExpiresAt: creds.accessTokenExpiresAt }
        : null,
      flow: view,
    };
  }

  async function poll(
    controller: AbortController,
    code: Awaited<ReturnType<typeof requestDeviceCode>>,
  ): Promise<void> {
    const stopKeepAlive = deps.keepAlive?.() ?? (() => undefined);
    try {
      const tokens = await pollForTokens(code, {
        clientId: deps.clientId,
        fetchImpl: deps.fetchImpl,
        now: deps.now,
        signal: controller.signal,
        sleep: deps.sleep ?? defaultSleep,
      });
      if (controller.signal.aborted) return;
      const login = await fetchLogin(deps.fetchImpl, tokens.accessToken);
      await deps.auth.completeSignIn(tokens, login);
      await show({ state: 'signed_in', login });
    } catch (error) {
      // Cancelled: whoever cancelled already showed what comes next.
      if (controller.signal.aborted) return;
      const message =
        error instanceof DeviceFlowError
          ? error.message
          : `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`;
      deps.log?.(`GitHub sign-in failed: ${message}`);
      await show({ state: 'failed', message });
    } finally {
      stopKeepAlive();
      if (flow?.controller === controller) flow = null;
    }
  }

  return {
    status,

    async start() {
      stopFlow();
      if (!isAppConfigured(deps.clientId, deps.slug)) {
        await show({
          state: 'failed',
          message: 'This build has no GitHub App to sign in with. Paste a token instead.',
        });
        return status();
      }
      const controller = new AbortController();
      flow = { controller, done: Promise.resolve() };
      const current = flow;
      try {
        const code = await requestDeviceCode({
          clientId: deps.clientId,
          fetchImpl: deps.fetchImpl,
          now: deps.now,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return await status();
        deps.log?.('GitHub sign-in started: waiting for the code to be entered on GitHub');
        await show({
          state: 'waiting',
          userCode: code.userCode,
          verificationUri: code.verificationUri,
          expiresAt: code.expiresAt,
        });
        current.done = poll(controller, code);
      } catch (error) {
        if (flow === current) flow = null;
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          deps.log?.(`GitHub sign-in failed: ${message}`);
          await show({ state: 'failed', message });
        }
      }
      return status();
    },

    async cancel() {
      if (flow) {
        stopFlow();
        deps.log?.('GitHub sign-in cancelled');
      }
      await show({ state: 'idle' });
      return status();
    },

    async signOut() {
      stopFlow();
      await deps.auth.signOut();
      await show({ state: 'idle' });
      return status();
    },

    async settled() {
      await flow?.done;
    },
  };
}
