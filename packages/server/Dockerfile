# syntax=docker/dockerfile:1
#
# review-ratio server. Build from the repository root:
#   docker build -f packages/server/Dockerfile -t review-ratio-server .
#   docker run --rm -p 8080:8080 review-ratio-server
#
# The runtime image holds one self-contained bundle (no node_modules) and runs as `node`.

ARG NODE_VERSION=22.22.0

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /repo
RUN corepack enable
# Manifests first, so the dependency layer is cached until a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter "@review-ratio/server..."
COPY tsconfig.base.json ./
COPY packages/contract packages/contract
COPY packages/server packages/server
RUN pnpm --filter @review-ratio/server build

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    TRUSTED_PROXY_HOPS=0
WORKDIR /app
# Owned by root and read-only to the `node` user: the process cannot rewrite its own code.
COPY --from=build /repo/packages/server/dist/node.js ./server.js
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
CMD ["node", "server.js"]
