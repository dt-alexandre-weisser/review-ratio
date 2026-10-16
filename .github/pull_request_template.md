## What

<!-- One or two sentences: what this change does and why. -->

## Checklist

- [ ] `pnpm check` passes locally (format, lint, typecheck, unit tests, build).
- [ ] `pnpm test:e2e` passes when the extension changed.
- [ ] Nothing leaves the browser except GitHub API calls made with the user's token.
- [ ] Formula changes keep the anchor invariant, update the scored fixture snapshots on purpose, and are listed in CHANGELOG.md: the scoring page shows the new values by itself.
