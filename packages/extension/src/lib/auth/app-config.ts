/**
 * The review-ratio GitHub App, for "Sign in with GitHub". Only its public client ID ships in the
 * extension: the device flow needs nothing else. The app has no client secret and no private
 * key, and none would ever belong here.
 *
 * A fork that registers its own app (see `docs/github-app-setup.md`) replaces both values. Set
 * back to a `REPLACE_WITH_…` placeholder, the options page offers the token mode only.
 */

/** The app's client ID, from its settings page. Public by design. */
export const GITHUB_APP_CLIENT_ID = 'Iv23liaLstZmfaSt3Q1K';

/** The app's slug, the last part of `https://github.com/apps/<slug>`. */
export const GITHUB_APP_SLUG = 'review-ratio';

const PLACEHOLDER = 'REPLACE_WITH_';

/** Whether the build has an app to sign in with: both values set, neither a placeholder. */
export function isAppConfigured(
  clientId: string = GITHUB_APP_CLIENT_ID,
  slug: string = GITHUB_APP_SLUG,
): boolean {
  return (
    Boolean(clientId && slug) && !clientId.startsWith(PLACEHOLDER) && !slug.startsWith(PLACEHOLDER)
  );
}

/** Where an organisation owner installs the app. */
export function installUrl(slug: string = GITHUB_APP_SLUG): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
