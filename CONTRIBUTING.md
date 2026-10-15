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
3. Run `pnpm test:e2e` when the extension, the server routes or the contract changed.
4. Open a pull request. CI runs the same gates plus the end-to-end suite and a Docker smoke test.

## CI gates

| Gate                       | Where                                                        |
| -------------------------- | ------------------------------------------------------------ |
| Formatting                 | `pnpm format:check` (Prettier)                               |
| Lint                       | `pnpm lint` (ESLint, typescript-eslint strict type-checked)  |
| Types                      | `pnpm typecheck` (strict, every package)                     |
| Frozen schemas             | `freeze.mjs`, `frozen.test.ts`, and a comparison with `main` |
| Fixtures of every major    | `packages/server/test/contract-gates.test.ts`                |
| Anchor invariant per major | `packages/server/test/contract-gates.test.ts`                |
| Coverage thresholds        | `pnpm test:coverage`                                         |
| Extension end to end       | `pnpm test:e2e`                                              |
| Server image               | Docker build and smoke test in CI                            |

## The contract

The extension and the server both import `@review-ratio/contract`, so drift is a compile error.
Installed extensions keep running old builds, so a released schema never changes.

`packages/contract/frozen.json` pins, per major, the hash of its schema file (`src/vN.ts`) and of
each of its fixture files, and whether the major is released. Schema files import nothing but
ArkType, so the hash covers every constant they use. Prettier skips them, so a formatter upgrade
cannot change a pin.

| Command (in `packages/contract`)      | Effect                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `node scripts/freeze.mjs`             | Verify every pin. CI and `pnpm test` run it.                                               |
| `node scripts/freeze.mjs --pin N`     | Pin major N. Re-pins only while unreleased; on a released major it only adds new fixtures. |
| `node scripts/freeze.mjs --release N` | Mark major N released. Its pins can never change again.                                    |

CI also compares `frozen.json` with `main`'s: a branch cannot change or unrelease a major that
`main` released.

**Non-breaking change** (a new optional field the server could ignore): not possible inside a
major. Payload schemas reject unknown keys, so old servers would reject new payloads. Add a major.

**New major:**

1. Copy `packages/contract/src/v1.ts` to `v2.ts`, edit the copy, export it from `index.ts`, add it
   to `CONTRACT_MAJORS` and set `LATEST_CONTRACT_VERSION`.
2. Add fixtures under `packages/contract/fixtures/v2/` and register them in `fixtures/index.ts`.
3. Add `packages/server/src/decoders/v2.ts`, register it in `DECODERS`, and add an anchor builder in
   `packages/server/test/anchors.ts`.
4. Switch the extension's `buildPayload` to the new schema.
5. `node scripts/freeze.mjs --pin 2`, and `--release 2` in the release commit.

**Retiring a major** is a deliberate server change: move it from `DECODERS` to `RETIRED_MAJORS`.
Its payloads then get `426 Upgrade Required` and the badge says "update the extension".

Major 1 is pinned but not released yet. Release it with the first extension release.

## The formula

The formula lives in `packages/server/src/formula.ts` and nowhere else. Never send its weights or
parameters to the extension. A formula change must keep the anchor invariant; the scored fixture
snapshots in `packages/server/test/__snapshots__` show its effect and are updated on purpose with
`pnpm vitest run -u`.

## Style

- TypeScript strict everywhere. No `any`, no non-null assertions outside tests.
- Pure logic in `lib/`, injected dependencies (`fetch`, storage, clock) for tests.
- Comments explain why, not what.
