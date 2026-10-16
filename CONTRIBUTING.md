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
