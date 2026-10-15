#!/bin/bash
# Installs the workspace dependencies in Claude Code cloud sessions so that
# `pnpm test`, `pnpm lint`, `pnpm typecheck` and `pnpm build` work right away.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

if ! command -v pnpm > /dev/null 2>&1; then
  corepack enable
fi

# Plain install (not --frozen-lockfile) so the cached container keeps working when a branch
# changes a manifest. Idempotent: a no-op when node_modules is already up to date.
pnpm install --prefer-offline --reporter=append-only

# Playwright resolves the preinstalled Chromium through PLAYWRIGHT_BROWSERS_PATH, which cloud
# sessions set; never download browsers here.
echo 'export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1' >> "${CLAUDE_ENV_FILE:-/dev/null}"
