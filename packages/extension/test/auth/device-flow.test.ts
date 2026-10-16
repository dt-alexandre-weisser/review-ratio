import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DeviceFlowError,
  pollForTokens,
  requestDeviceCode,
  sleep,
  type DeviceCode,
  type DeviceFlowErrorCode,
} from '../../src/lib/auth/device-flow.ts';
import { fakeFetch, json } from '../helpers/fetch.ts';

const NOW = Date.parse('2026-10-15T12:00:00Z');

const CODE_ANSWER = {
  device_code: 'dev_secret',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 899,
  interval: 5,
};

const GRANTED = {
  access_token: 'ghu_new',
  expires_in: 28_800,
  refresh_token: 'ghr_new',
  refresh_token_expires_in: 15_897_600,
  token_type: 'bearer',
};

afterEach(() => {
  vi.useRealTimers();
});

async function failure(promise: Promise<unknown>): Promise<DeviceFlowErrorCode> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DeviceFlowError);
  return (error as DeviceFlowError).code;
}

describe('requestDeviceCode', () => {
  const request = (fetchImpl: typeof fetch, signal?: AbortSignal) =>
    requestDeviceCode({
      clientId: 'Iv1.x',
      fetchImpl,
      now: () => NOW,
      ...(signal ? { signal } : {}),
    });

  it('asks GitHub for a code with the client ID alone', async () => {
    const fetchImpl = fakeFetch(() => json(CODE_ANSWER));
    expect(await request(fetchImpl)).toEqual({
      deviceCode: 'dev_secret',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresAt: NOW + 899_000,
      intervalMs: 5_000,
    });
    const { url, init } = fetchImpl.calls[0]!;
    expect(url).toBe('https://github.com/login/device/code');
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ client_id: 'Iv1.x' });
  });

  it('falls back to GitHub defaults for a missing interval or lifetime', async () => {
    const { interval: _i, expires_in: _e, ...bare } = CODE_ANSWER;
    expect(await request(fakeFetch(() => json(bare)))).toMatchObject({
      expiresAt: NOW + 900_000,
      intervalMs: 5_000,
    });
  });

  it('names what GitHub refused', async () => {
    const answers: [Response, DeviceFlowErrorCode][] = [
      [json({ error: 'device_flow_disabled' }), 'disabled'],
      [json({ error: 'incorrect_client_credentials' }), 'bad_client'],
      [json({ error: 'unauthorized_client' }), 'bad_client'],
      [json({ error: 'something_new' }), 'unknown'],
      [json({}, { status: 404 }), 'bad_client'],
      [json({}, { status: 401 }), 'bad_client'],
      [json({}, { status: 503 }), 'network'],
      [json({}, { status: 422 }), 'unknown'],
      [json({ ...CODE_ANSWER, verification_uri: 'https://evil.example/login' }), 'unknown'],
      [json({ ...CODE_ANSWER, user_code: 7 }), 'unknown'],
      [json([CODE_ANSWER]), 'unknown'],
    ];
    for (const [answer, code] of answers) {
      expect(await failure(request(fakeFetch(() => answer.clone())))).toBe(code);
    }
  });

  it('reports a network failure, or a cancel while waiting for GitHub', async () => {
    const offline = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await failure(request(offline))).toBe('network');
    const controller = new AbortController();
    const cancelled = () => {
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    };
    expect(await failure(request(cancelled, controller.signal))).toBe('cancelled');
  });
});

describe('pollForTokens', () => {
  const code: DeviceCode = {
    deviceCode: 'dev_secret',
    userCode: 'WDJB-MJHT',
    verificationUri: 'https://github.com/login/device',
    expiresAt: NOW + 900_000,
    intervalMs: 5_000,
  };

  function setup(answers: (Response | Error)[]) {
    let clock = NOW;
    const waits: number[] = [];
    const fetchImpl = fakeFetch(() => {
      const next = answers.shift();
      if (next === undefined) throw new Error('no more answers');
      if (next instanceof Error) throw next;
      return next;
    });
    const poll = (signal?: AbortSignal) =>
      pollForTokens(code, {
        clientId: 'Iv1.x',
        fetchImpl,
        now: () => clock,
        sleep: (ms) => {
          waits.push(ms);
          clock += ms;
          return Promise.resolve();
        },
        ...(signal ? { signal } : {}),
      });
    return { fetchImpl, waits, poll, advance: (ms: number) => (clock += ms) };
  }

  it('waits the interval before each poll, until the code is entered', async () => {
    const { fetchImpl, waits, poll } = setup([
      json({ error: 'authorization_pending' }),
      json({ error: 'authorization_pending' }),
      json(GRANTED),
    ]);
    expect(await poll()).toEqual({
      accessToken: 'ghu_new',
      accessTokenExpiresAt: NOW + 15_000 + 28_800_000,
      refreshToken: 'ghr_new',
      refreshTokenExpiresAt: NOW + 15_000 + 15_897_600_000,
    });
    expect(waits).toEqual([5_000, 5_000, 5_000]);
    expect(fetchImpl.calls.map((c) => c.url)).toEqual(
      Array(3).fill('https://github.com/login/oauth/access_token'),
    );
    expect(Object.fromEntries(fetchImpl.calls[0]!.init.body as URLSearchParams)).toEqual({
      client_id: 'Iv1.x',
      device_code: 'dev_secret',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
  });

  it('slows down by 5 seconds each time, or to the interval GitHub asks', async () => {
    const { waits, poll } = setup([
      json({ error: 'slow_down' }),
      json({ error: 'slow_down', interval: 30 }),
      json({ error: 'slow_down', interval: 2 }),
      json(GRANTED),
    ]);
    await poll();
    expect(waits).toEqual([5_000, 10_000, 30_000, 35_000]);
  });

  it('stops on each error GitHub ends the flow with', async () => {
    const errors: [string, DeviceFlowErrorCode][] = [
      ['expired_token', 'expired'],
      ['token_expired', 'expired'],
      ['access_denied', 'denied'],
      ['device_flow_disabled', 'disabled'],
      ['incorrect_client_credentials', 'bad_client'],
      ['incorrect_device_code', 'bad_device_code'],
      ['unsupported_grant_type', 'unsupported_grant'],
      ['something_new', 'unknown'],
    ];
    for (const [error, expected] of errors) {
      const { poll } = setup([json({ error, error_description: 'x' })]);
      expect(await failure(poll())).toBe(expected);
    }
    const noToken = setup([json({ token_type: 'bearer' })]);
    expect(await failure(noToken.poll())).toBe('unknown');
  });

  it('gives up when the code expires by the local clock, without another poll', async () => {
    const { fetchImpl, poll, advance } = setup([json({ error: 'authorization_pending' })]);
    advance(896_000);
    expect(await failure(poll())).toBe('expired');
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('rides out two network failures in a row, not three', async () => {
    const offline = () => new TypeError('Failed to fetch');
    const flaky = setup([
      offline(),
      json({}, { status: 502 }),
      json({ error: 'authorization_pending' }),
      offline(),
      json({}, { status: 429 }),
      json(GRANTED),
    ]);
    expect((await flaky.poll()).accessToken).toBe('ghu_new');
    const down = setup([offline(), json({}, { status: 500 }), offline()]);
    expect(await failure(down.poll())).toBe('network');
    const outage = setup([0, 1, 2].map(() => new Response('<html>', { status: 503 })));
    expect(await failure(outage.poll())).toBe('network');
  });

  it('stops at once when cancelled', async () => {
    const controller = new AbortController();
    const { fetchImpl, poll } = setup([]);
    controller.abort();
    expect(await failure(poll(controller.signal))).toBe('cancelled');
    expect(fetchImpl.calls).toHaveLength(0);
    const during = new AbortController();
    const cancelling = pollForTokens(code, {
      clientId: 'Iv1.x',
      fetchImpl: () => {
        during.abort();
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      },
      now: () => NOW,
      signal: during.signal,
      sleep: () => Promise.resolve(),
    });
    expect(await failure(cancelling)).toBe('cancelled');
  });
});

describe('sleep', () => {
  it('waits, or rejects as cancelled as soon as the signal aborts', async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void sleep(1_000).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();

    const controller = new AbortController();
    const waiting = sleep(60_000, controller.signal);
    controller.abort();
    expect(await failure(waiting)).toBe('cancelled');
    expect(await failure(sleep(1, controller.signal))).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has a plain-word message for every failure', () => {
    for (const code of [
      'expired',
      'denied',
      'disabled',
      'bad_client',
      'bad_device_code',
      'unsupported_grant',
      'network',
      'cancelled',
      'unknown',
    ] as const) {
      expect(new DeviceFlowError(code).message).toMatch(/^[A-Z].+\.$/);
    }
  });
});
