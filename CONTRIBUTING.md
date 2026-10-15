# Contributing

## Setup

```sh
corepack enable
pnpm install
pnpm check
```

Node 22.12 or later. `pnpm test:e2e` needs Chromium: run `pnpm exec playwright install chromium`
once on a new machine.

## Workflow

1. Branch from `main`.
2. Keep each change small and covered by tests. `pnpm check` must pass.
3. Run `pnpm test:e2e` when the extension, the server routes or the contract changed.
4. Open a pull request. CI runs the same gates plus the end-to-end suite and a Docker smoke test.

## CI gates

| Gate                       | Where                                                       |
| -------------------------- | ----------------------------------------------------------- |
| Formatting                 | `pnpm format:check` (Prettier)                              |
| Lint                       | `pnpm lint` (ESLint, typescript-eslint strict type-checked) |
| Types                      | `pnpm typecheck` (strict, every package)                    |
| Frozen schemas             | `packages/contract/scripts/freeze.mjs` and `frozen.test.ts` |
| Fixtures of every major    | `packages/server/test/contract-gates.test.ts`               |
| Anchor invariant per major | `packages/server/test/contract-gates.test.ts`               |
| Coverage thresholds        | `pnpm test:coverage`                                        |
| Extension end to end       | `pnpm test:e2e`                                             |
| Server image               | Docker build and smoke test in CI                           |

## The contract

The extension and the server both import `@review-ratio/contract`, so drift is a compile error.
Installed extensions keep running old builds, so a released schema never changes.

**Non-breaking change** (a new optional field the server can ignore): not allowed inside a major
either. Payload schemas reject unknown keys, so old servers would reject new payloads. Add a major.

**New major:**

1. Copy `packages/contract/src/v1.ts` to `v2.ts`, edit the copy, export it from `index.ts`, add it
   to `CONTRACT_MAJORS` and set `LATEST_CONTRACT_VERSION`.
2. Add fixtures under `packages/contract/fixtures/v2/` and register them in `fixtures/index.ts`.
3. Add `packages/server/src/decoders/v2.ts`, register it in `DECODERS`, and add an anchor builder in
   `packages/server/test/anchors.ts`.
4. Switch the extension's `buildPayload` to the new schema.
5. Pin the new schema: `pnpm --filter @review-ratio/contract freeze`. This only adds the new hash;
   the gate still fails if an older major changed.

**Retiring a major** is a deliberate server change: move it from `DECODERS` to `RETIRED_MAJORS`.
Its payloads then get `426 Upgrade Required` and the badge says "update the extension".

Major 1 is pinned but not released yet. Until the first release, a change to `v1.ts` is allowed:
re-pin it with `pnpm --filter @review-ratio/contract freeze`.

## The formula

The formula lives in `packages/server/src/formula.ts` and nowhere else. Never send its weights or
parameters to the extension. A formula change must keep the anchor invariant; the scored fixture
snapshots in `packages/server/test/__snapshots__` show its effect and are updated on purpose with
`pnpm vitest run -u`.

## Style

- TypeScript strict everywhere. No `any`, no non-null assertions outside tests.
- Pure logic in `lib/`, injected dependencies (`fetch`, storage, clock) for tests.
- Comments explain why, not what.
