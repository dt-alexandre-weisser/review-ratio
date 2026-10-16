import { describe, expect, it } from 'vitest';

import { diagnose } from '../src/lib/diagnose.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { fakeFetch, json } from './helpers/fetch.ts';

const settings = { ...DEFAULT_SETTINGS, token: 'tok' };
const NOW = Date.parse('2026-10-15T12:00:00Z');

function github(overrides: { user?: Response; repos?: Response; search?: Response } = {}) {
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
