# Changelog

## 0.1.0 (2026-10-20)

First prototype.

- No organisation built in. The options page asks for one, and the badge reads
  `review-ratio: set up` until it has one. Save checks that the organisation lets review-ratio
  read it, and names the case when it does not: app not installed, installation limited to some
  repositories, SAML single sign-on, fine-grained tokens refused, token not approved.

- Scoring in the extension: the formula (weights, decay, size tiers, rescue), the bundled class
  globs, rounding and record caps, with scored fixtures against a snapshot and the anchor
  invariant. Nothing leaves the browser except the GitHub API calls made with the user's token.
- **How Review Points are counted**: a page of the extension, linked from the options page, that
  renders every weight, threshold and glob from the constants the formula runs on.
- This replaces the earlier prototype's review-ratio server and contract package (anonymous
  payload, opaque formula, contract majors, Docker image): the same GitHub activity scores the
  same.
- Extension (Chrome MV3): badge in the GitHub header with every state of the design; options page
  with token, organisation and exclude list, diagnostics and a connection test that checks
  organisation access; per-file review coverage, cached comparisons, per-PR error
  isolation, rate-limit back-off; token hidden from content scripts.
- Activity log on the options page: every call of the last 30 minutes with its time, status and
  duration, plus refresh start and end lines; live, copyable, kept in memory only.
- The badge sits just left of the header's search bar, and checks that it shows there. When the
  header has no place for it, it floats in the bottom-right corner instead of not showing; the
  options page says where it went and what it saw of the header. ↑ and ↓ take GitHub's colours
  for added and removed lines, from the user's theme.
- Each logged call can show what it sent: the GraphQL query and variables.
- No badge flicker between pages: the badge is placed as soon as GitHub's React header is ready
  and put back before the next paint when GitHub replaces the header. Refreshes at most every 5
  minutes (the design said 10), from the cache in between.
- Sign in with GitHub, recommended: the review-ratio GitHub App through the device flow, run by
  the background worker. The options page shows the code and a link to GitHub, and switches to
  "Signed in as …" by itself. The 8-hour token renews itself (5 minutes before expiry, or once
  after a 401); a refused or expired refresh token signs out and the badge asks to set up. Only
  the app's public client ID ships: no client secret, no private key. Pasting a token stays
  available. Test connection runs in the worker and, with the app, checks that it is installed on
  the organisation. The sign-in calls are logged without what they sent or received.
- CI: format, lint, typecheck (scripts included), unit and formula tests with coverage
  thresholds, build, end-to-end tests in Chromium.
- Install without building: every push to `main` that changes the extension publishes
  `review-ratio.zip` as the Latest GitHub Release, at a stable download URL, versioned
  `<version>.<run number>`. The README installs from it.
- Chrome Web Store, prepared: a `v*` tag uploads the build and submits it for review with the
  Store API v2, once the secrets exist (docs/chrome-web-store.md). The Store zip has no manifest
  `key`. Listing text, permission justifications, privacy answers, PRIVACY.md and the Store images
  (`pnpm store:images`, generated against the fake GitHub).
