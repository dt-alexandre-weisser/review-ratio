# The review-ratio GitHub App

**Sign in with GitHub** goes through the review-ratio GitHub App and GitHub's device flow. The
extension ships the app's public client ID and nothing else: the app has no client secret and no
private key.

| Value     | Where                                                     |
| --------- | --------------------------------------------------------- |
| Name      | review-ratio                                              |
| Slug      | `review-ratio`, so <https://github.com/apps/review-ratio> |
| Client ID | `Iv23liaLstZmfaSt3Q1K`                                    |
| Install   | <https://github.com/apps/review-ratio/installations/new>  |

Both values live in
[`packages/extension/src/lib/auth/app-config.ts`](../packages/extension/src/lib/auth/app-config.ts).

## Install it on the organisation

Done once per organisation, by one of its owners:

1. Open <https://github.com/apps/review-ratio/installations/new> and pick the organisation.
2. Choose **All repositories**. With **Only select repositories**, the badge only counts reviews
   in those, and Test connection says so when none of a developer's repositories is included.
3. Approve the permissions: read-only access to Contents, Pull requests and Metadata.

Each developer then clicks **Sign in with GitHub** on the options page and types the code shown
there at <https://github.com/login/device>. Their token reaches what both they and the
installation can reach, never more. **Test connection** says when the app is not installed on the
organisation, with the install link.

To remove it: the organisation's **Settings → GitHub Apps → review-ratio → Configure →
Uninstall**. A developer revokes their own sign-in in **Settings → Applications → Authorized
GitHub Apps**; **Sign out** in the extension only forgets the tokens in that browser.

## The app's settings

Created at **Settings → Developer settings → GitHub Apps → New GitHub App**, with:

| Setting                                                | Value                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| GitHub App name                                        | `review-ratio`                                                     |
| Homepage URL                                           | <https://github.com/dt-alexandre-weisser/review-ratio>             |
| Callback URL                                           | empty (see below)                                                  |
| Expire user authorization tokens                       | on                                                                 |
| Request user authorization (OAuth) during installation | off                                                                |
| Enable Device Flow                                     | on                                                                 |
| Setup URL                                              | empty                                                              |
| Webhook › Active                                       | off                                                                |
| Repository permissions                                 | Contents: Read-only, Pull requests: Read-only, Metadata: Read-only |
| Organization permissions                               | none                                                               |
| Account permissions                                    | none                                                               |
| Subscribe to events                                    | none                                                               |
| Where can this GitHub App be installed?                | Any account                                                        |

After creation:

- **Client secrets:** none. Do not generate one. The device flow and token renewal send the client
  ID alone, and a secret could not be kept secret in an extension anyway.
- **Private keys:** none. The extension never acts as the app itself, only as the signed-in
  developer. If one was generated, delete it.

The device flow has no redirect, so the callback URL is never used. If the form insists on one,
put the homepage URL.

"Expire user authorization tokens" makes GitHub issue an 8-hour access token and a refresh token
of about 6 months; the extension renews the first with the second. Turned off, the tokens never
expire and the extension uses them until GitHub rejects them.

## A fork with its own app

Register an app with the settings above, then set `GITHUB_APP_CLIENT_ID` (from the app's settings
page) and `GITHUB_APP_SLUG` (the last part of `https://github.com/apps/<slug>`) in
`packages/extension/src/lib/auth/app-config.ts`. Set either back to a `REPLACE_WITH_…` placeholder
to build an extension that offers the token mode only.
