import { describe, expect, it } from 'vitest';

import { diagnose } from '../src/lib/diagnose.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { fakeFetch, json } from './helpers/fetch.ts';

const settings = { ...DEFAULT_SETTINGS, token: 'tok' };
const NOW = Date.parse('2026-10-15T12:00:00Z');

function github(
  overrides: {
    user?: Response;
    repos?: Response;
    search?: Response;
    installations?: Response;
  } = {},
) {
  return fakeFetch((url) => {
    if (url.pathname === '/user') {
      return (
        overrides.user ??
        json(
          { login: 'me' },
          { headers: { 'github-authentication-token-expiration': '2027-01-01 00:00:00 UTC' } },
        )
      );
    }
    if (url.pathname === '/orgs/DiliTrust/repos') return overrides.repos ?? json([{ id: 1 }]);
    if (url.pathname === '/search/issues') return overrides.search ?? json({ total_count: 42 });
    if (url.pathname === '/user/installations') {
      return (
        overrides.installations ?? json({ installations: [{ account: { login: 'dilitrust' } }] })
      );
    }
    return json({}, { status: 404 });
  });
}

describe('diagnose', () => {
  it('reports a working setup', async () => {
    const fetchImpl = github();
    const result = await diagnose(settings, fetchImpl, NOW);
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('token works for me, expires 2027-01-01');
    expect(result.lines.join('\n')).toContain('42 pull requests of DiliTrust');
    expect(new Set(fetchImpl.calls.map((c) => new URL(c.url).host))).toEqual(
      new Set(['api.github.com']),
    );
    const search = fetchImpl.calls.find((c) => c.url.includes('/search/issues'))!;
    expect(new URL(search.url).searchParams.get('q')).toBe(
      'is:pr org:DiliTrust updated:>=2026-10-08',
    );
  });

  it('flags a token that cannot see the organisation private repositories', async () => {
    const result = await diagnose(settings, github({ repos: json([]) }), NOW);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('sees no private repository of DiliTrust');
  });

  it('flags an unknown organisation, a missing permission and a rejected token', async () => {
    expect(
      (await diagnose(settings, github({ repos: json({}, { status: 404 }) }), NOW)).lines.join(),
    ).toContain('not found');
    expect(
      (await diagnose(settings, github({ repos: json({}, { status: 403 }) }), NOW)).lines.join(),
    ).toContain('permissions');
    expect(
      (await diagnose(settings, github({ user: json({}, { status: 401 }) }), NOW)).lines.join(),
    ).toContain('token rejected (401)');
  });

  it('flags a missing token', async () => {
    const noToken = await diagnose({ ...settings, token: '' }, github(), NOW);
    expect(noToken.ok).toBe(false);
    expect(noToken.lines).toEqual(['GitHub: no token yet.']);
  });
});

describe('diagnose, signed in with the GitHub App', () => {
  const INSTALL = 'https://github.com/apps/review-ratio/installations/new';
  const app = { accessTokenExpiresAt: NOW + 8 * 3_600_000, installUrl: INSTALL };

  it('reports the sign-in, its renewal and the installation on the organisation', async () => {
    const fetchImpl = github();
    const result = await diagnose(settings, fetchImpl, NOW, app);
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toMatch(
      /^GitHub: signed in as me with the GitHub App, current token valid until \d\d:\d\d and renewed by itself \(\? API calls left this hour\)\.$/,
    );
    expect(result.lines.join('\n')).toContain('42 pull requests of DiliTrust');
    expect(fetchImpl.calls.map((c) => new URL(c.url).pathname)).toContain('/user/installations');
  });

  it('leaves the expiry out for a token that does not expire', async () => {
    const result = await diagnose(settings, github(), NOW, { ...app, accessTokenExpiresAt: null });
    expect(result.lines[0]).toBe(
      'GitHub: signed in as me with the GitHub App (? API calls left this hour).',
    );
  });

  it('says where to install the app when the organisation has not', async () => {
    const fetchImpl = github({
      installations: json({ installations: [{ account: { login: 'someone-else' } }, {}] }),
    });
    const result = await diagnose(settings, fetchImpl, NOW, app);
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toBe(
      `GitHub: the review-ratio app is not installed on DiliTrust. An owner of DiliTrust installs it here: ${INSTALL}`,
    );
    expect(fetchImpl.calls.some((c) => c.url.includes('/orgs/'))).toBe(false);
  });

  it('flags an installation that sees no private repository', async () => {
    const result = await diagnose(settings, github({ repos: json([]) }), NOW, app);
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toContain(
      'the review-ratio app sees no private repository of DiliTrust',
    );
    expect(result.lines.at(-1)).toContain(INSTALL);
  });

  it('goes on to the repositories when GitHub does not list the installations', async () => {
    const result = await diagnose(
      settings,
      github({ installations: json({}, { status: 403 }) }),
      NOW,
      app,
    );
    expect(result.ok).toBe(true);
  });

  it('flags a missing or rejected sign-in', async () => {
    expect((await diagnose({ ...settings, token: '' }, github(), NOW, app)).lines).toEqual([
      'GitHub: not signed in yet.',
    ]);
    expect(
      (await diagnose(settings, github({ user: json({}, { status: 401 }) }), NOW, app)).lines,
    ).toEqual(['GitHub: the sign-in was rejected (401). Sign out and sign in again.']);
  });
});
