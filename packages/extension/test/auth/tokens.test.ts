import { describe, expect, it } from 'vitest';

import {
  TOKEN_URL,
  TokenRejectedError,
  parseTokens,
  postLogin,
  renewTokens,
} from '../../src/lib/auth/tokens.ts';
import { GitHubError } from '../../src/lib/github/client.ts';
import { fakeFetch, json } from '../helpers/fetch.ts';

const NOW = Date.parse('2026-10-15T12:00:00Z');

const GRANTED = {
  access_token: 'ghu_new',
  expires_in: 28_800,
  refresh_token: 'ghr_new',
  refresh_token_expires_in: 15_897_600,
  token_type: 'bearer',
  scope: '',
};

describe('parseTokens', () => {
  it('reads the tokens and turns their lifetimes into dates', () => {
    expect(parseTokens(GRANTED, NOW)).toEqual({
      accessToken: 'ghu_new',
      accessTokenExpiresAt: NOW + 8 * 3_600_000,
      refreshToken: 'ghr_new',
      refreshTokenExpiresAt: NOW + 15_897_600_000,
    });
  });

  it('reads a token that does not expire, from an app with expiring tokens turned off', () => {
    expect(parseTokens({ access_token: 'ghu_x', token_type: 'bearer' }, NOW)).toEqual({
      accessToken: 'ghu_x',
      accessTokenExpiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
    expect(
      parseTokens({ access_token: 'ghu_x', refresh_token: '', refresh_token_expires_in: 5 }, NOW)
        ?.refreshTokenExpiresAt,
    ).toBeNull();
  });

  it('finds no tokens in an error or in garbage', () => {
    expect(parseTokens({ error: 'authorization_pending' }, NOW)).toBeNull();
    expect(parseTokens({ access_token: '' }, NOW)).toBeNull();
    expect(parseTokens(null, NOW)).toBeNull();
    expect(parseTokens([GRANTED], NOW)).toBeNull();
    expect(parseTokens({ ...GRANTED, expires_in: -1 }, NOW)?.accessTokenExpiresAt).toBeNull();
  });
});

describe('postLogin', () => {
  it('posts a form, asks for JSON, and reads the answer', async () => {
    const fetchImpl = fakeFetch(() => json({ ok: 1 }, { status: 201 }));
    expect(await postLogin(fetchImpl, TOKEN_URL, { client_id: 'Iv1.x', a: 'b c' })).toEqual({
      status: 201,
      body: { ok: 1 },
    });
    const { init } = fetchImpl.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ accept: 'application/json' });
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect((init.body as URLSearchParams).toString()).toBe('client_id=Iv1.x&a=b+c');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads an outage page as no body, and stops when asked', async () => {
    const outage = fakeFetch(() => new Response('<html>', { status: 503 }));
    expect(await postLogin(outage, TOKEN_URL, {})).toEqual({ status: 503, body: null });
    const controller = new AbortController();
    const seen = fakeFetch((_url, init) => {
      controller.abort();
      expect(init.signal?.aborted).toBe(true);
      return json({});
    });
    await postLogin(seen, TOKEN_URL, {}, controller.signal);
    expect(seen.calls).toHaveLength(1);
  });
});

describe('renewTokens', () => {
  const renew = (fetchImpl: typeof fetch) =>
    renewTokens({ clientId: 'Iv1.x', refreshToken: 'ghr_old', fetchImpl, now: () => NOW });

  it('trades the refresh token for new ones, with the client ID and no secret', async () => {
    const fetchImpl = fakeFetch(() => json(GRANTED));
    expect(await renew(fetchImpl)).toMatchObject({
      accessToken: 'ghu_new',
      refreshToken: 'ghr_new',
    });
    const { url, init } = fetchImpl.calls[0]!;
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      client_id: 'Iv1.x',
      grant_type: 'refresh_token',
      refresh_token: 'ghr_old',
    });
  });

  it('says when GitHub refuses the refresh token', async () => {
    const refused = await renew(fakeFetch(() => json({ error: 'bad_refresh_token' }))).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(TokenRejectedError);
    expect((refused as TokenRejectedError).code).toBe('bad_refresh_token');
    await expect(renew(fakeFetch(() => json({}, { status: 400 })))).rejects.toBeInstanceOf(
      TokenRejectedError,
    );
  });

  it('keeps the old tokens usable when GitHub cannot answer', async () => {
    for (const fetchImpl of [
      fakeFetch(() => json({}, { status: 502 })),
      fakeFetch(() => json({}, { status: 429 })),
      fakeFetch(() => json({ token_type: 'bearer' })),
      () => Promise.reject(new TypeError('Failed to fetch')),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      () => Promise.reject('offline'),
    ]) {
      const error = await renew(fetchImpl).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitHubError);
      expect(error).not.toBeInstanceOf(TokenRejectedError);
    }
  });
});
