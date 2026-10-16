import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  coerceSettings,
  isExcludedRepo,
  isValidOrg,
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

describe('coerceSettings', () => {
  it('returns the defaults for garbage', () => {
    expect(coerceSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(coerceSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(coerceSettings({ token: 3, org: '  ', excludedRepos: 'a' })).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and drops the server URL older versions stored', () => {
    expect(
      coerceSettings({
        token: ' t ',
        org: 'Acme',
        excludedRepos: ['A', 1],
        serverUrl: 'https://x/',
      }),
    ).toEqual({ authMode: 'pat', token: 't', org: 'Acme', excludedRepos: ['a'] });
  });

  it('keeps the app mode, and reads anything else as the token mode', () => {
    expect(coerceSettings({ authMode: 'app' }).authMode).toBe('app');
    expect(coerceSettings({ authMode: 'oauth' }).authMode).toBe('pat');
    // Settings saved before the app mode existed have a token and no mode.
    expect(coerceSettings({ token: 't' }).authMode).toBe('pat');
  });
});

describe('isValidOrg', () => {
  it('accepts GitHub organisation names only', () => {
    expect(isValidOrg('DiliTrust')).toBe(true);
    expect(isValidOrg('a-b-1')).toBe(true);
    expect(isValidOrg('')).toBe(false);
    expect(isValidOrg('-a')).toBe(false);
    expect(isValidOrg('a--b')).toBe(false);
    expect(isValidOrg('a b')).toBe(false);
    expect(isValidOrg('org:x')).toBe(false);
    expect(isValidOrg('a'.repeat(40))).toBe(false);
  });
});
