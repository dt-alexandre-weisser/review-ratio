# Chrome Web Store

review-ratio is meant to be listed on the Chrome Web Store as **Unlisted**: only people with the
link find it, and it installs and updates like any other extension. Once set up, pushing a `v*`
tag uploads the build and submits it for review, from the Release workflow
(`.github/workflows/release.yml`, job **Chrome Web Store**, script
`.github/scripts/chrome-web-store.sh`). Until the secrets below exist, that job is skipped with a
notice and the tag still gets its GitHub Release.

## One-time setup

### 1. Developer account

1. Turn on 2-step verification on the Google account that will own the item: the Store requires
   it to publish.
2. Register at <https://chrome.google.com/webstore/devconsole> and pay the one-time $5 fee.
3. Note the **publisher ID**: Developer Dashboard › **Publisher** › **Settings**.

### 2. Create the item

The API updates an item; it does not create one. Upload the first zip by hand:

1. Download `review-ratio-chrome-web-store.zip` from the latest release:
   <https://github.com/dt-alexandre-weisser/review-ratio/releases/latest>. Every release carries
   it, next to `review-ratio.zip`; every Release workflow run also keeps both in its artifact
   `review-ratio-<version>`. Use the Store zip: it has no manifest `key` (see below).
2. Developer Dashboard › **New item** › upload the zip. Note the **item ID** the Store assigns: it
   is the extension id of the Store version.
3. **Store listing** tab: fill it from [Listing content](#listing-content); upload the images from
   `store/`.
4. **Privacy** tab: fill it from [Privacy tab](#privacy-tab).
5. **Distribution** tab: visibility **Unlisted**, all regions (or the ones you need).
6. **Submit for review**. The first review can take several days.

Change the visibility from the dashboard only, and publish once by hand after a change: the API
does not change visibility.

### 3. API access

From the Store's "Use the Chrome Web Store API" guide
(<https://developer.chrome.com/docs/webstore/using-api>):

1. In the Google Cloud console, create a project (for example `review-ratio-publish`).
2. **APIs & Services › Library**: enable **Chrome Web Store API**.
3. **OAuth consent screen**: user type **External**, app name `review-ratio publish`, your email
   as support and developer contact. Under **Test users**, add the Google account of the
   Store publisher.
4. **Credentials › Create credentials › OAuth client ID**: type **Web application**, authorised
   redirect URI `https://developers.google.com/oauthplayground`. Note the **client ID** and
   **client secret**.
5. Open <https://developers.google.com/oauthplayground>:
   1. Gear icon › **Use your own OAuth credentials**: paste the client ID and secret.
   2. Step 1, scope: `https://www.googleapis.com/auth/chromewebstore`, then **Authorize APIs**,
      signed in as the Store publisher.
   3. Step 2: **Exchange authorization code for tokens**. Copy the **refresh token**.

A consent screen left in **Testing** issues refresh tokens that expire after 7 days. Publish it
(**Publishing status › In production**) so the refresh token lasts until revoked. Google may then
show an "unverified app" warning when you authorise in the OAuth Playground: you are the only user,
continue past it.

### 4. Repository secrets

Settings › Secrets and variables › Actions › **New repository secret**, one per row:

| Secret              | Value                                       |
| ------------------- | ------------------------------------------- |
| `CWS_PUBLISHER_ID`  | The publisher ID from step 1                |
| `CWS_EXTENSION_ID`  | The item ID from step 2                     |
| `CWS_CLIENT_ID`     | The OAuth client ID from step 3             |
| `CWS_CLIENT_SECRET` | The OAuth client secret from step 3         |
| `CWS_REFRESH_TOKEN` | The refresh token from the OAuth Playground |

The API v2 paths name both the publisher and the item
(`publishers/<publisher>/items/<item>`), so both IDs are needed.

### 5. Release

`packages/extension/package.json` holds the version. To ship it to the Store:

```sh
git tag v0.1.0        # must be v + packages/extension/package.json version
git push origin v0.1.0
```

The Release workflow checks the tag against the version, builds `0.1.0.<run number>`, publishes
the GitHub Release `v0.1.0`, uploads the Store zip and submits it for review. A failure shows the
API's error in the job. After a release, bump the version in `packages/extension/package.json`
for the next one.

## How the versions work

The zips carry `<package.json version>.<workflow run number>`, for example `0.1.0.57`, and a
`version_name` the browser shows instead: `0.1.0 build 57 (1a2b3c4)` for a main build, `0.1.0`
for a tag build. The Store refuses a version that is not higher than the last one uploaded. Main
builds and tag builds run in the same workflow, so they share the run number and the version
always grows.

## The manifest `key`

The manifest's `key` pins the extension id of unpacked installs, from the release zip or a local
build. The Store's documentation does not say whether an uploaded `key` is refused or ignored; the
Store gives every item its own id and key anyway. The Store zip leaves `key` out, so the question
does not arise. Nothing in the extension depends on its id: it reads `chrome.runtime.id` at run
time, and the GitHub App's device flow has no redirect URL.

The Store version therefore has another id than the unpacked one, and its own storage: someone
moving from the zip to the Store signs in again.

## Listing content

**Name** (from the manifest): `review-ratio`

**Short description** (the manifest `description`, 132 characters at most):

> A private badge in the GitHub header: how much you review compared to how much you ask to be
> reviewed.

**Category**: Developer Tools. **Language**: English.

**Detailed description**:

> review-ratio shows a private badge in the github.com header: how much code review you gave
> compared to how much you asked others for, over the last 7 days. It works like a torrent ratio,
> for code review.
>
> ↑ 64,129 RP · ↓ 43,002 RP | Ratio 1.49
>
> Review Points (RP) count the review work: lines reviewed, weighted by the kind of file
> (production code, tests, docs…), the size of the change and how recent it is. ↑ is what you gave,
> ↓ is what you asked for. The whole formula is public: the options page links to "How Review
> Points are counted", which shows every weight, threshold and glob.
>
> Private by design. Only you see your ratio. There is no server, no team view, no leaderboard and
> no telemetry: the extension reads your own review activity from the GitHub API with read-only
> access, scores it in your browser, and shows the result in the header.
>
> Setup: sign in with GitHub (the review-ratio GitHub App, read-only), or paste a fine-grained
> personal access token. The options page lists every call the extension made in the last 30
> minutes.

**Images**, generated by `pnpm store:images` into `store/`:

| File                            | Store field      | Size     |
| ------------------------------- | ---------------- | -------- |
| `store/icon-128.png`            | Store icon       | 128×128  |
| `store/screenshot-badge.png`    | Screenshot 1     | 1280×800 |
| `store/screenshot-options.png`  | Screenshot 2     | 1280×800 |
| `store/promo-small-440x280.png` | Small promo tile | 440×280  |

The script loads the built extension in Chromium against the fake GitHub of the end-to-end tests.
No request reaches the network: the fake answers `github.com` and `api.github.com`, every other
request is aborted, Chromium resolves no host name, and the script fails if any request went
elsewhere or none reached the fake API.

## Privacy tab

**Single purpose**:

> Show the signed-in developer, in the github.com header, a private ratio of the code review they
> gave to the code review they asked for over the last 7 days.

**Permission justifications**:

| Permission                 | Justification                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                  | Keeps the settings, the GitHub token, the cached badge and the caches that avoid re-reading pull requests, in the browser only.                             |
| `scripting`                | Puts the badge back into github.com tabs that were already open when the extension was installed or updated, without reloading them.                        |
| `https://api.github.com/*` | Reads the user's own pull requests and reviews from the GitHub API, with the user's read-only access, to compute the ratio.                                 |
| `https://github.com/*`     | Shows the badge in the github.com header (content script), and signs in with the review-ratio GitHub App through GitHub's device flow (`github.com/login`). |

**Remote code**: No. All the code is in the package.

**Data usage**: tick

- **Authentication information**: the GitHub access and refresh tokens, or the pasted token. Kept
  in the browser and sent only to GitHub.
- **Website content**: pull request metadata, file paths and line counts read from the GitHub API
  to compute the ratio. Processed in the browser; file paths are discarded after classification.

Leave the other categories unticked: no personal communications, location, web history, health,
financial data, or user activity monitoring. The extension sends the user's own GitHub login to
GitHub in its queries, and nowhere else.

Tick the three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**:
<https://github.com/dt-alexandre-weisser/review-ratio/blob/main/PRIVACY.md>
