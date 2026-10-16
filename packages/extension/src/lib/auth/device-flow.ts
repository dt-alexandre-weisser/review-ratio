/**
 * OAuth device flow for the GitHub App: GitHub gives a short code, the developer types it at
 * github.com/login/device, and the extension polls until GitHub answers a token. It needs the
 * app's public client ID only. It runs in the service worker, never in a content script.
 *
 * GitHub answers the polls with HTTP 200 and an `error` field until the code is entered.
 */
import { DEVICE_CODE_URL, TOKEN_URL, parseTokens, postLogin, type AppTokens } from './tokens.ts';

export interface DeviceCode {
  /** Secret to the extension: only the poll sends it. Never shown, stored or logged. */
  deviceCode: string;
  /** What the developer types on GitHub, e.g. `WDJB-MJHT`. */
  userCode: string;
  verificationUri: string;
  /** When the code stops working, in ms since the epoch. */
  expiresAt: number;
  /** How long to wait between polls. */
  intervalMs: number;
}

export type DeviceFlowErrorCode =
  | 'expired'
  | 'denied'
  | 'disabled'
  | 'bad_client'
  | 'bad_device_code'
  | 'unsupported_grant'
  | 'network'
  | 'cancelled'
  | 'unknown';

/** What the options page shows, in words a developer can act on. */
const MESSAGES: Record<DeviceFlowErrorCode, string> = {
  expired: 'The code expired before it was entered on GitHub. Sign in again for a new one.',
  denied: 'Sign-in was refused on GitHub. Sign in again to retry.',
  disabled:
    'The GitHub App does not allow this sign-in: its owner must turn on "Enable Device Flow" in the app settings.',
  bad_client:
    'GitHub does not know this app. The extension was built with a wrong client ID: tell its maintainers.',
  bad_device_code: 'GitHub did not recognise the sign-in. Sign in again for a new code.',
  unsupported_grant:
    'GitHub refused the sign-in request. Sign in again; if it persists, tell the maintainers.',
  network: 'GitHub cannot be reached. Check the connection, then sign in again.',
  cancelled: 'Sign-in cancelled.',
  unknown: 'GitHub answered something unexpected. Sign in again.',
};

export class DeviceFlowError extends Error {
  constructor(readonly code: DeviceFlowErrorCode) {
    super(MESSAGES[code]);
    this.name = 'DeviceFlowError';
  }
}

/** GitHub's default when it gives no interval, and what `slow_down` adds each time. */
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_MS = 5_000;
/** Polls that fail on the network in a row before the flow gives up. */
const MAX_NETWORK_FAILURES = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function errorCode(error: string): DeviceFlowErrorCode {
  switch (error) {
    // Both spellings exist in GitHub's documentation.
    case 'expired_token':
    case 'token_expired':
      return 'expired';
    case 'access_denied':
      return 'denied';
    case 'device_flow_disabled':
      return 'disabled';
    case 'incorrect_client_credentials':
    case 'unauthorized_client':
      return 'bad_client';
    case 'incorrect_device_code':
      return 'bad_device_code';
    case 'unsupported_grant_type':
      return 'unsupported_grant';
    default:
      return 'unknown';
  }
}

export interface DeviceFlowOptions {
  clientId: string;
  fetchImpl: typeof fetch;
  now: () => number;
  signal?: AbortSignal;
}

/** Asks GitHub for a code to show the developer. */
export async function requestDeviceCode(options: DeviceFlowOptions): Promise<DeviceCode> {
  let answer: { status: number; body: unknown };
  try {
    answer = await postLogin(
      options.fetchImpl,
      DEVICE_CODE_URL,
      { client_id: options.clientId },
      options.signal,
    );
  } catch {
    if (options.signal?.aborted) throw new DeviceFlowError('cancelled');
    throw new DeviceFlowError('network');
  }
  const { status, body } = answer;
  if (isRecord(body) && typeof body['error'] === 'string') {
    throw new DeviceFlowError(errorCode(body['error']));
  }
  // An unknown client ID answers 404.
  if (status === 404 || status === 401) throw new DeviceFlowError('bad_client');
  if (status >= 400) throw new DeviceFlowError(status >= 500 ? 'network' : 'unknown');
  if (
    !isRecord(body) ||
    typeof body['device_code'] !== 'string' ||
    typeof body['user_code'] !== 'string' ||
    typeof body['verification_uri'] !== 'string' ||
    !body['verification_uri'].startsWith('https://github.com/')
  ) {
    throw new DeviceFlowError('unknown');
  }
  return {
    deviceCode: body['device_code'],
    userCode: body['user_code'],
    verificationUri: body['verification_uri'],
    expiresAt: options.now() + (positive(body['expires_in']) ?? 900) * 1000,
    intervalMs: (positive(body['interval']) ?? DEFAULT_INTERVAL_S) * 1000,
  };
}

/** Resolves after `ms`, or rejects with `cancelled` as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeviceFlowError('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DeviceFlowError('cancelled'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Polls until the developer entered the code, then returns the tokens. Waits the interval GitHub
 * asked for before each poll, longer after each `slow_down`. Stops when the code expires by the
 * local clock even if GitHub never says so, and after a few network failures in a row.
 */
export async function pollForTokens(
  code: DeviceCode,
  options: DeviceFlowOptions & { sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
): Promise<AppTokens> {
  const wait = options.sleep ?? sleep;
  let intervalMs = code.intervalMs;
  let failures = 0;
  for (;;) {
    await wait(intervalMs, options.signal);
    if (options.signal?.aborted) throw new DeviceFlowError('cancelled');
    if (options.now() >= code.expiresAt) throw new DeviceFlowError('expired');
    let answer: { status: number; body: unknown };
    try {
      answer = await postLogin(
        options.fetchImpl,
        TOKEN_URL,
        {
          client_id: options.clientId,
          device_code: code.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        options.signal,
      );
    } catch {
      if (options.signal?.aborted) throw new DeviceFlowError('cancelled');
      failures += 1;
      if (failures >= MAX_NETWORK_FAILURES) throw new DeviceFlowError('network');
      continue;
    }
    const { status, body } = answer;
    const error = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : null;
    if (error === null && (status >= 500 || status === 429)) {
      failures += 1;
      if (failures >= MAX_NETWORK_FAILURES) throw new DeviceFlowError('network');
      continue;
    }
    failures = 0;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      const asked = isRecord(body) ? positive(body['interval']) : null;
      intervalMs = Math.max(intervalMs + SLOW_DOWN_MS, (asked ?? 0) * 1000);
      continue;
    }
    if (error !== null) throw new DeviceFlowError(errorCode(error));
    const tokens = parseTokens(body, options.now());
    if (!tokens) throw new DeviceFlowError('unknown');
    return tokens;
  }
}
