# Firefox Add-ons

Firefox installs only add-ons that Mozilla signed. review-ratio is signed on the **unlisted**
channel of addons.mozilla.org (AMO): Mozilla signs it, AMO does not list it, and this repository's
GitHub Releases distribute it. Once set up, pushing a `v*` tag has AMO sign the Firefox build and
publishes the signed file, from the Release workflow (`.github/workflows/release.yml`, job
**Firefox Add-ons**, script `.github/scripts/firefox-add-ons.sh`). Until the secrets below exist,
that job is skipped with a notice and the tag still gets its GitHub Release and its Chrome Web
Store submission.

The add-on does not exist on AMO yet: the first signing creates it, under the id `@review-ratio`,
owned by the account of the API keys.

## One-time setup

### 1. Firefox account

1. Create a Mozilla account at <https://accounts.firefox.com>, or use an existing one.
2. Turn on two-step authentication in the account settings: AMO requires it to submit add-ons.
3. Sign in at <https://addons.mozilla.org/developers/> and accept the Firefox Add-on Distribution
   Agreement when the Developer Hub asks for it. AMO issues no API keys before.

### 2. API keys

1. Open <https://addons.mozilla.org/developers/addon/api/key/>, signed in as that account.
2. Click **Generate new credentials**. Note the **JWT issuer** (`user:12345:67`) and the **JWT
   secret**: the page shows the secret once.

Generating new credentials revokes the old ones.

### 3. Repository secrets

From your own terminal, in a clone of the repository; `gh` asks for each value, which stays out of
the shell history:

```sh
gh secret set AMO_JWT_ISSUER
gh secret set AMO_JWT_SECRET
```

| Secret           | Value                      |
| ---------------- | -------------------------- |
| `AMO_JWT_ISSUER` | The JWT issuer from step 2 |
| `AMO_JWT_SECRET` | The JWT secret from step 2 |

## Release

The same tag releases Chrome and Firefox (see [chrome-web-store.md](chrome-web-store.md), step 5):

```sh
git tag v0.1.0        # must be v + packages/extension/package.json version
git push origin v0.1.0
```

After the tag's GitHub Release exists, the **Firefox Add-ons** job:

1. Submits `review-ratio-firefox.zip` with `web-ext sign --channel unlisted`, and the source of
   the tagged commit (`git archive`) with `--upload-source-code`: the bundle is generated from
   TypeScript, and Mozilla's policies ask for the source of generated code.
2. Waits for AMO to validate and sign it, 15 minutes at most. Unlisted versions are signed after
   the automatic validation; Mozilla may still review them later.
3. Attaches the signed file to the tag's release as `review-ratio-<version>.xpi`.
4. On the fixed release `firefox`, replaces `review-ratio.xpi` and `updates.json`, unless that
   release already serves a newer version. The job creates the release the first time, as a
   prerelease, so it never becomes Latest.

Two links stay the same across versions:

| Link                                                                                              | Use                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| <https://github.com/dt-alexandre-weisser/review-ratio/releases/download/firefox/review-ratio.xpi> | Install: open it in Firefox                             |
| <https://github.com/dt-alexandre-weisser/review-ratio/releases/download/firefox/updates.json>     | The manifest's `update_url`, which installs check daily |

`updates.json` lists one version, its `update_link` (the versioned file on the tag's release, never
replaced) and the file's SHA-256, which Firefox checks before it installs the update. GitHub
answers both links with a redirect to its file storage; Firefox follows redirects for the update
manifest and for the download.

`releases/latest` would not do as the `update_url`: it is the newest main build, which carries no
signed file.

## How the versions work

The Firefox zip has the same version as the Chrome zips, `<package.json version>.<run number>`,
which Firefox accepts as is. AMO refuses a version it already has. Firefox has no `version_name`:
the Firefox zip leaves it out, and Firefox shows the four-part version.

## The Firefox build

`pnpm build` also writes `packages/extension/dist-firefox/`, from the same code. Its manifest comes
from the shared `manifest.json` (`packages/extension/scripts/firefox.mjs`):

- The background runs as an event page (`background.scripts`): Firefox has no background service
  worker.
- No `key` or `minimum_chrome_version`, which only Chrome reads.
- `browser_specific_settings.gecko`: the id `@review-ratio`, the `update_url`, the data declaration
  below, and `strict_min_version` 143, the first Firefox with `storage.session.getKeys()`.

The code is not minified, so AMO's reviewers read what they sign. `pnpm lint:firefox` runs AMO's
linter on `dist-firefox` with `--self-hosted`: `update_url` is allowed for unlisted add-ons only.
CI and the Release workflow run it.

**Data declaration.** Mozilla asks every new add-on to declare the data it transmits, and counts as
transmitted any data handled outside the add-on or the browser, whoever receives it
(<https://extensionworkshop.com/documentation/publish/add-on-policies/>, "Data Collection and
Transmission Disclosure and Control";
<https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/>). The extension
sends the GitHub token, and the user's login in its queries, to GitHub: it declares
`authenticationInfo` as required, the counterpart of **Authentication information** on the Chrome
Web Store privacy tab. Firefox shows it in the install prompt.

**Storage access.** Firefox has no `storage.local.setAccessLevel`
([bug 1724754](https://bugzilla.mozilla.org/show_bug.cgi?id=1724754)): there, the content script's
context can read `storage.local`, and so the token. See [SECURITY.md](../SECURITY.md).

## What is manual

- The account, its two-step authentication, the agreement, the API keys and the two secrets.
- Rotating the keys: generate new credentials, then set both secrets again.
- Nothing per release. An unlisted add-on has no listing page to fill.

## When the job fails

- **Missing secrets**: the job is skipped with a notice. After setting them, start a fresh run for
  the tag, `gh workflow run release.yml --ref v0.1.0`. It builds and submits a new version.
- **Authentication error** (401 or 403): the keys were regenerated or revoked. Generate new
  credentials and set both secrets again.
- **Version already exists**: the run had signed this version before, and a re-run sends it again.
  Start a fresh run, as above.
- **Validation errors**: AMO's validator refused the package; the log lists each error.
  `pnpm build && pnpm lint:firefox` shows most of them locally.
- **Approval timeout**: AMO held the version longer than 15 minutes. It gets signed later; download
  the signed file from the add-on's page in the Developer Hub, the log gives the link. Then start
  a fresh run, or attach it to the releases by hand with the `updates.json` that
  `packages/extension/scripts/firefox.mjs` prints for it.
- **Add-on ID already in use**: another add-on took `@review-ratio`. Change `GECKO_ID` in
  `packages/extension/scripts/firefox.mjs`; installs with the old id do not move to the new one.
