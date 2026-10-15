import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  coerceSettings,
  isExcludedRepo,
  normalizeServerUrl,
  parseExcludeList,
} from '../src/lib/settings.ts';

describe('parseExcludeList', () => {
  it('reads one repo per line, skipping blanks and comments, lowercased and deduplicated', () => {
    expect(
      parseExcludeList('DiliTrust/Legacy\n\n# old\n  sandbox  \ndilitrust/legacy\r\n'),
    ).toEqual(['dilitrust/legacy', 'sandbox']);
  });
});

describe('isExcludedRepo', () => {
  const settings = { org: 'DiliTrust', excludedRepos: ['dilitrust/legacy', 'sandbox'] };

  it('matches full names and bare names within the org, case-insensitively', () => {
    expect(isExcludedRepo(settings, 'DiliTrust/Legacy')).toBe(true);
    expect(isExcludedRepo(settings, 'DiliTrust/sandbox')).toBe(true);
    expect(isExcludedRepo(settings, 'Other/sandbox')).toBe(false);
    expect(isExcludedRepo(settings, 'DiliTrust/app')).toBe(false);
  });
});

describe('normalizeServerUrl', () => {
  it('trims trailing slashes and falls back to the default', () => {
    expect(normalizeServerUrl(' https://rr.example.com/// ')).toBe('https://rr.example.com');
    expect(normalizeServerUrl('')).toBe(DEFAULT_SETTINGS.serverUrl);
  });
});

describe('coerceSettings', () => {
  it('returns the defaults for garbage', () => {
    expect(coerceSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(coerceSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(coerceSettings({ token: 3, org: '  ', excludedRepos: 'a', serverUrl: null })).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  it('keeps valid values', () => {
    expect(
      coerceSettings({
        token: ' t ',
        org: 'Acme',
        excludedRepos: ['A', 1],
        serverUrl: 'https://x/',
      }),
    ).toEqual({ token: 't', org: 'Acme', excludedRepos: ['a'], serverUrl: 'https://x' });
  });
});
