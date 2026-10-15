import { describe, expect, it } from 'vitest';

import { badgeView } from '../src/lib/badge-state.ts';
import { isBadgeUpdate, isRequest } from '../src/lib/messages.ts';
import { EMPTY_CACHE } from '../src/lib/storage.ts';

describe('message guards', () => {
  it('accepts the known requests only', () => {
    expect(isRequest({ type: 'badge:get' })).toBe(true);
    expect(isRequest({ type: 'badge:refresh' })).toBe(true);
    expect(isRequest({ type: 'cache:get' })).toBe(true);
    expect(isRequest({ type: 'settings:steal' })).toBe(false);
    expect(isRequest(null)).toBe(false);
    expect(isRequest('badge:get')).toBe(false);
  });

  it('accepts badge updates with a view only', () => {
    expect(isBadgeUpdate({ type: 'badge:update', view: badgeView(EMPTY_CACHE, 0) })).toBe(true);
    expect(isBadgeUpdate({ type: 'badge:update' })).toBe(false);
    expect(isBadgeUpdate({ type: 'badge:get', view: {} })).toBe(false);
    expect(isBadgeUpdate(undefined)).toBe(false);
  });
});
