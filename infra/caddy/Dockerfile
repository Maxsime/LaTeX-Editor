# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22.23.4-alpine
ARG CADDY_IMAGE=caddy:2.11.7-alpine

FROM ${NODE_IMAGE} AS build
# Optional build secret `extra_ca_cert`: CA bundle of a TLS-inspecting proxy, for builds
# on corporate or school networks. Unused when absent.
RUN --mount=type=secret,id=extra_ca_cert \
    if [ -s /run/secrets/extra_ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca_cert; fi; \
    npm install --global --no-fund --no-audit pnpm@10.28.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    --mount=type=secret,id=extra_ca_cert \
    if [ -s /run/secrets/extra_ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca_cert; fi; \
    pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@galley/web..."
RUN pnpm --filter "@galley/web..." run build
# Source maps stay out of the image: they weigh about 10 MB, more than the application.
# The assets are compressed once here rather than by Caddy on every request.
RUN find apps/web/dist -name '*.map' -delete && \
    node apps/web/scripts/precompress.mjs apps/web/dist/assets

FROM ${CADDY_IMAGE}
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
