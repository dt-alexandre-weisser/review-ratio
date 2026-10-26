# review-ratio — Claude Code context

A Chrome MV3 extension: a private review-ratio badge in the github.com header. Product in
[DESIGN.md](DESIGN.md), workflow and gates in [CONTRIBUTING.md](CONTRIBUTING.md).

## Gates

`pnpm check` runs format, lint, typecheck, unit tests and build. Run `pnpm test:e2e` and
`pnpm lint:firefox` too when the extension changed. `pnpm store:images` regenerates `store/*.png` when the options page or the badge
changes how it looks.

## Organisation agnostic

**The extension, its docs, tests and Store images name no real organisation.** The developer types
theirs in the options. Fixtures use `AcmeCorp` (`ORG` in `e2e/fake-github.ts`). An organisation can
refuse review-ratio: `src/lib/diagnose.ts` names each case, and Save shows it. A new refusal case
goes there, with a unit test and a row in the README's "When your organisation says no".

## Chrome Web Store

The item is live and **public**. Publishing is automatic from a `v*` tag. The procedure and the
listing content are in [docs/chrome-web-store.md](docs/chrome-web-store.md).

| What                 | Value                                                |
| -------------------- | ---------------------------------------------------- |
| Item ID (Store id)   | `daofncnlecpehibjbeebegpfabmcbinh`                   |
| Unpacked zip id      | `bhmdipijifghpkibegnfchgcafodlgnb`, pinned by `key`  |
| Google Cloud project | `review-ratio`, OAuth consent screen in production   |
| Repo secrets         | all five `CWS_*` are set                             |
| First API release    | `v0.1.0`, version `0.1.0.3`, submitted on 2026-10-20 |

**The version lives in `packages/extension/package.json`, never in `manifest.json`.** The
`"version": "0.0.0"` of `packages/extension/manifest.json` is a placeholder: leave it.
`scripts/package.mjs` stamps the zipped manifests with `version` = `<package.json version>.<run
number>` and, for a tag build, `version_name` = the bare `<package.json version>`. The Developer
Dashboard and `chrome://extensions` show `version_name`, so two releases of the same
`package.json` version look identical there. Every release bumps it.

**Pick the bump from what changed in the extension since the last tag** (`git log
v<last>..origin/main -- packages/extension`):

- patch: fixes and wording, no new behaviour;
- minor: a new feature or setting;
- major: a change that drops saved settings or makes users sign in again.

A new entry in `permissions` or `host_permissions` that carries an install warning makes Chrome
disable the extension after the update until each user accepts it. Say so in the PR and in the
CHANGELOG.

**To release:**

1. In one PR, bump `version` in `packages/extension/package.json`, and turn the CHANGELOG's
   unreleased section into `## <version> (<YYYY-MM-DD>)`. Merge it.
2. Tag the merge commit `v<version>` (`v0.1.1`) and push the tag. The build refuses a tag that does
   not match `package.json` (`releaseVersion` in `scripts/package.mjs`).
3. The Release workflow publishes the GitHub Release, uploads the Store zip and submits it. The
   job ends at `PENDING_REVIEW`. Google reviews every version, then Chrome updates the Store
   installs by itself.
4. Once Google approves it, Chrome's update service answers with the new version:
   `curl -s 'https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3&prodversion=140.0&x=id%3Ddaofncnlecpehibjbeebegpfabmcbinh%26uc'`.

**What the API does not do.** It uploads the package only. Listing text, screenshots and
visibility change by hand in the Developer Dashboard.

**When the Store job fails:**

- Missing secrets: the job is skipped with a notice. After setting them, re-run the same tag run
  (`gh run rerun <id>`): a re-run reads the current secrets and keeps its version.
- Auth error: the refresh token lapsed (revoked, or 6 months unused). Get a new one from the OAuth
  Playground (docs/chrome-web-store.md § 3) and set `CWS_REFRESH_TOKEN` again. The user sets it
  from their own terminal, never through the chat.
- Version refused: the Store wants a version higher than the last upload. Versions are
  `<package.json version>.<run number>`, so a fresh run fixes it.

## Firefox

**The add-on does not exist on addons.mozilla.org yet.** The first `v*` tag pushed once both
`AMO_*` secrets are set signs it, and that signing creates it. The procedure is in
[docs/firefox-add-ons.md](docs/firefox-add-ons.md).

| What            | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| Channel         | unlisted (self-distributed): Mozilla signs, GitHub Releases distribute |
| Gecko id        | `@review-ratio` (`GECKO_ID` in `scripts/firefox.mjs`), never changes   |
| Minimum Firefox | 143, for `storage.session.getKeys()`                                   |
| Install link    | `releases/download/firefox/review-ratio.xpi`                           |
| `update_url`    | `releases/download/firefox/updates.json`                               |
| Repo secrets    | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`: not set yet                        |

`pnpm build` writes `dist-firefox/` next to `dist/`; `scripts/firefox.mjs` derives its manifest
from `manifest.json`. The same tag releases both browsers, with the same version. The Release job
**Firefox Add-ons** signs `review-ratio-firefox.zip` with `web-ext sign --channel unlisted`,
attaches `review-ratio-<version>.xpi` to the tag's release, then updates the fixed prerelease
`firefox`. Do not delete that release or its tag: every install reads `updates.json` from it.

**When the Firefox job fails:**

- Missing secrets: the job is skipped with a notice. After the user sets them from their own
  terminal (`gh secret set AMO_JWT_ISSUER`, never through the chat), start a fresh run for the
  tag: `gh workflow run release.yml --ref v<version>`.
- Version already exists: AMO already signed this version (a re-run). A fresh run fixes it.
- Approval timeout: AMO held the version for more than 15 minutes; it is signed later, from the
  Developer Hub link in the log.

## Ongoing work

Work started and not merged yet. An entry goes away with the PR that finishes it.

None.
