# syntax=docker/dockerfile:1
# Builds one Node service of the monorepo: docker build --build-arg SERVICE=api ...
ARG NODE_IMAGE=node:22.23.4-alpine

FROM ${NODE_IMAGE} AS base
# Optional build secret `extra_ca_cert`: CA bundle of a TLS-inspecting proxy, for builds
# on corporate or school networks. Unused when absent.
RUN --mount=type=secret,id=extra_ca_cert \
    if [ -s /run/secrets/extra_ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca_cert; fi; \
    npm install --global --no-fund --no-audit pnpm@10.28.0
WORKDIR /repo

FROM base AS build
ARG SERVICE
# Fetch dependencies from the lockfile alone, so this layer survives source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    --mount=type=secret,id=extra_ca_cert \
    if [ -s /run/secrets/extra_ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca_cert; fi; \
    pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@galley/${SERVICE}..."
RUN pnpm --filter "@galley/${SERVICE}..." run build
# Production dependencies only, resolved from the same lockfile.
FROM build AS prod-deps
ARG SERVICE
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules && \
    pnpm install --prod --offline --frozen-lockfile --filter "@galley/${SERVICE}..."

FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
# Keep the workspace layout so the pnpm symlinks between packages stay valid.
COPY --from=prod-deps --chown=node:node /repo/package.json ./
COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /repo/packages/shared ./packages/shared
COPY --from=prod-deps --chown=node:node /repo/apps/${SERVICE} ./apps/${SERVICE}
WORKDIR /app/apps/${SERVICE}
USER node
CMD ["node", "dist/server.js"]
