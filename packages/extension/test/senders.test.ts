import { describe, expect, it } from 'vitest';

import { isTrustedFor } from '../src/background/senders.ts';

const ID = 'bhmdipijifghpkibegnfchgcafodlgnb';
const ORIGIN = `chrome-extension://${ID}/`;
const options = { id: ID, url: `${ORIGIN}options.html` };
const github = { id: ID, url: 'https://github.com/DiliTrust/app/pulls' };

describe('isTrustedFor', () => {
  it('lets the options page do everything', () => {
    for (const type of ['badge:get', 'badge:refresh', 'cache:get'] as const) {
      expect(isTrustedFor({ type }, options, ID, ORIGIN)).toBe(true);
    }
  });

  it('lets the github.com content script ask for the badge only', () => {
    expect(isTrustedFor({ type: 'badge:get' }, github, ID, ORIGIN)).toBe(true);
    expect(isTrustedFor({ type: 'badge:refresh' }, github, ID, ORIGIN)).toBe(false);
    expect(isTrustedFor({ type: 'cache:get' }, github, ID, ORIGIN)).toBe(false);
  });

  it('refuses other extensions and other pages', () => {
    expect(isTrustedFor({ type: 'badge:get' }, { ...options, id: 'other' }, ID, ORIGIN)).toBe(
      false,
    );
    expect(
      isTrustedFor({ type: 'badge:get' }, { id: ID, url: 'https://evil.example/' }, ID, ORIGIN),
    ).toBe(false);
    expect(isTrustedFor({ type: 'badge:get' }, { id: ID }, ID, ORIGIN)).toBe(false);
  });
});
