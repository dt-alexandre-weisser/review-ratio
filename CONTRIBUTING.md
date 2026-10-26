# Contributing

## Setup

```sh
corepack enable
pnpm install
pnpm check
```

Node 22.13 or later. `pnpm test:e2e` needs Chromium: run `pnpm exec playwright install chromium`
once on a new machine.

## Workflow

1. Branch from `main`.
2. Keep each change small and covered by tests. `pnpm check` must pass.
3. Run `pnpm test:e2e` when the extension changed.
4. Open a pull request. CI runs the same gates plus the end-to-end suite.

## CI gates

| Gate                 | Where                                                            |
| -------------------- | ---------------------------------------------------------------- |
| Formatting           | `pnpm format:check` (Prettier)                                   |
| Lint                 | `pnpm lint` (ESLint, typescript-eslint strict type-checked)      |
| Types                | `pnpm typecheck` (strict, scripts included)                      |
| Scored fixtures      | `packages/extension/test/scoring/gates.test.ts` and its snapshot |
| Anchor invariant     | `packages/extension/test/scoring/gates.test.ts`                  |
| Scoring page         | `packages/extension/test/scoring/render.test.ts`                 |
| Coverage thresholds  | `pnpm test:coverage`                                             |
| Extension end to end | `pnpm test:e2e`                                                  |
| Release zips load    | `e2e/package.spec.ts`                                            |
| Firefox build        | `pnpm lint:firefox` (addons.mozilla.org's linter, after a build) |
| Workflows            | `actionlint` (not in CI; run it when a workflow changes)         |

## Releases

Nobody builds the extension to install it: the Release workflow (`.github/workflows/release.yml`)
does, on every push to `main` that changes the extension, and on `v*` tags.

- It runs `pnpm check`, then `packages/extension/scripts/package.mjs`, which zips
  `packages/extension/dist` with the manifest at the root, stamped with the version
  `<packages/extension/package.json version>.<run number>` and a readable `version_name`.
  `dist/` and the repository keep version `0.0.0`.
- It publishes a GitHub Release with `review-ratio.zip` (to load unpacked),
  `review-ratio-chrome-web-store.zip` (the same without the manifest `key`) and
  `review-ratio-firefox.zip` (`packages/extension/dist-firefox`, unsigned). A main build is tagged
  `build-<version>`; the newest release is marked Latest, so
  <https://github.com/dt-alexandre-weisser/review-ratio/releases/latest/download/review-ratio.zip>
  always serves it. Only the 10 newest `build-*` releases are kept, enough to go back a few builds;
  `v*` releases stay.
- A `v*` tag must match `packages/extension/package.json` (`v0.1.0` for `0.1.0`). It also submits
  the Store zip to the Chrome Web Store, once its secrets exist: see
  [docs/chrome-web-store.md](docs/chrome-web-store.md). And it has addons.mozilla.org sign the
  Firefox zip, published on the fixed release `firefox`, once its secrets exist: see
  [docs/firefox-add-ons.md](docs/firefox-add-ons.md).
- Run from another branch with **Run workflow**, it publishes a prerelease that never becomes
  Latest; delete it afterwards.

Locally, `pnpm package` writes the three zips to `packages/extension/release/` (version
`<version>.0`), and `pnpm store:images` regenerates the Store images in `store/` against the fake
GitHub. Commit the images when the badge or the options page changes visibly.

## The formula

The formula lives in `packages/extension/src/lib/scoring/`: `formula.ts` (weights, parameters,
decay, size tiers), `classes.ts` (the bundled class globs), `rounding.ts` and `records.ts`
(rounding and record caps). It is public: the **How Review Points are counted** page
(`packages/extension/src/scoring/`) renders it from these constants, so a change shows there by
itself. The page's HTML holds prose only; a unit test fails when it contains a digit, or a slot
without a value.

A formula change must keep the anchor invariant. The scored fixture snapshot in
`packages/extension/test/scoring/__snapshots__` shows its effect: update it on purpose with
`pnpm vitest run -u`, and say in CHANGELOG.md what moved. Every installed extension scores with
the formula it shipped with until it updates.

## Style

- TypeScript strict everywhere. No `any`, no non-null assertions outside tests.
- Pure logic in `lib/`, injected dependencies (`fetch`, storage, clock) for tests.
- Comments explain why, not what.
