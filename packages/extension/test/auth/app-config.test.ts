import { describe, expect, it } from 'vitest';

import {
  GITHUB_APP_CLIENT_ID,
  GITHUB_APP_SLUG,
  installUrl,
  isAppConfigured,
} from '../../src/lib/auth/app-config.ts';

describe('app config', () => {
  it('ships the review-ratio app, with its public client ID only', () => {
    expect(GITHUB_APP_CLIENT_ID).toMatch(/^Iv[0-9a-zA-Z.]+$/);
    expect(GITHUB_APP_SLUG).toBe('review-ratio');
    expect(isAppConfigured()).toBe(true);
    expect(installUrl()).toBe('https://github.com/apps/review-ratio/installations/new');
  });

  it('turns the sign-in off for a placeholder or an empty value', () => {
    expect(isAppConfigured('REPLACE_WITH_CLIENT_ID', 'review-ratio')).toBe(false);
    expect(isAppConfigured('Iv23abc', 'REPLACE_WITH_APP_SLUG')).toBe(false);
    expect(isAppConfigured('', 'review-ratio')).toBe(false);
    expect(isAppConfigured('Iv23abc', '')).toBe(false);
    expect(isAppConfigured('Iv23abc', 'my-fork')).toBe(true);
  });

  it('builds the install link of another app', () => {
    expect(installUrl('my fork')).toBe('https://github.com/apps/my%20fork/installations/new');
  });
});
