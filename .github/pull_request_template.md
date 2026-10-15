## What

<!-- One or two sentences: what this change does and why. -->

## Checklist

- [ ] `pnpm check` passes locally (format, lint, typecheck, unit tests, build).
- [ ] `pnpm test:e2e` passes when the extension or the server changed.
- [ ] No released contract schema was edited. A breaking payload change adds a new major (see CONTRIBUTING.md).
- [ ] The payload still carries numbers only: no login, repository, PR number, path, extension, code or comment text.
- [ ] Formula changes keep the anchor invariant and update the scored fixture snapshots on purpose.
