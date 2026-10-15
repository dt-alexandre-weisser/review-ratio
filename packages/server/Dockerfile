# syntax=docker/dockerfile:1
#
# review-ratio server. Build from the repository root:
#   docker build -f packages/server/Dockerfile -t review-ratio-server .
#   docker run --rm -p 8080:8080 -e TRUSTED_PROXY_HOPS=0 review-ratio-server
#
# TRUSTED_PROXY_HOPS has no default on purpose: the server refuses to start without it, because
# the right value depends on what sits in front of it (docs/operations.md).
#
# The runtime image holds one self-contained bundle (no node_modules), runs as `node`, and has no
# package manager.

# Both stages use the multi-arch index digest of node:22.22.0-alpine, written out in full so that
# Dependabot can read and update tag and digest together (it does not follow build args).
FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34 AS build
WORKDIR /repo
# Corepack checks the pnpm tarball against the hash pinned in package.json#packageManager.
RUN corepack enable
# Manifests first, so the dependency layer is cached until a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY packages/server/package.json packages/server/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@review-ratio/server..."
COPY tsconfig.base.json ./
COPY packages/contract packages/contract
COPY packages/server packages/server
RUN pnpm --filter @review-ratio/server build:node

FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34 AS runtime
# No package manager at runtime (npm, yarn, corepack, apk): less to patch, nothing to install with.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg /sbin/apk /etc/apk /lib/apk /usr/share/apk /var/cache/apk
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
# Owned by root and read-only to the `node` user: the process cannot rewrite its own code.
COPY --from=build /repo/packages/server/dist/node.js /repo/packages/server/dist/node.js.map ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
CMD ["node", "--enable-source-maps", "node.js"]
