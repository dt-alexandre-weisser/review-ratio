import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  coerceSettings,
  isExcludedRepo,
  isValidOrg,
  normalizeServerUrl,
  parseExcludeList,
  serverUrlProblem,
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

describe('serverUrlProblem', () => {
  it('allows https anywhere and http on loopback only', () => {
    expect(serverUrlProblem('https://rr.example.com')).toBeNull();
    expect(serverUrlProblem('http://127.0.0.1:8787')).toBeNull();
    expect(serverUrlProblem('http://localhost:8787')).toBeNull();
    expect(serverUrlProblem('http://rr.example.com')).toMatch(/https/);
    expect(serverUrlProblem('ftp://x')).toMatch(/https/);
    expect(serverUrlProblem('not a url')).toMatch(/valid/);
    expect(serverUrlProblem('https://u:p@rr.example.com')).toMatch(/credentials/);
    expect(serverUrlProblem('https://rr.example.com/?a=1')).toMatch(/query/);
  });
});
