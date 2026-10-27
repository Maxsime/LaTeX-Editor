# syntax=docker/dockerfile:1
# Builds one Node service of the monorepo: docker build --build-arg SERVICE=api ...
ARG NODE_IMAGE=node:22.23.4-alpine
# TeX Live 2026 (texlive/texlive:latest-full of 2026-10-25), frozen by digest; changing
# the year is described in docs/operations.md. Node is copied from a glibc image for it.
ARG TEXLIVE_IMAGE=texlive/texlive:latest-full@sha256:540d736c78e2803cdd7b6a196bd21339c30185948db55e04e75a415959102ca8
ARG NODE_GLIBC_IMAGE=node:22.23.4-bookworm-slim

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

# Compiler worker: TeX Live with the worker beside it (SPEC §6.3).
FROM ${NODE_GLIBC_IMAGE} AS node-glibc

FROM ${TEXLIVE_IMAGE} AS compiler-runtime
ENV NODE_ENV=production
COPY --from=node-glibc /usr/local/bin/node /usr/local/bin/node
# Warm the caches that every sandbox mounts read-only, so that a first LuaLaTeX or
# Biber run does not spend 10 to 20 s rebuilding them. The fontconfig cache of the base
# image does not match TeX Live's font folders: without a rebuild, every XeLaTeX run
# rescans them into a sandbox /tmp that is thrown away, about 100 s each time. Biber (a PAR archive) unpacks
# itself into PAR_GLOBAL_TEMP; doing it as the worker user keeps the files usable there.
RUN set -eu; \
    tl=$(kpsewhich -var-value SELFAUTOPARENT); \
    TEXMFVAR="$tl/texmf-var" luaotfload-tool --update --force >/dev/null; \
    fc-cache --system-only --really-force >/dev/null; \
    install -d -o texlive -g texlive /opt/galley/par-cache /var/lib/galley/work; \
    cd /tmp; \
    printf '@book{a,title={T},author={A},year={2000}}' > warm.bib; \
    printf '%s' '\documentclass{article}\usepackage[backend=biber]{biblatex}\addbibresource{warm.bib}\begin{document}\cite{a}\printbibliography\end{document}' > warm.tex; \
    pdflatex -interaction=batchmode warm.tex >/dev/null; \
    chown texlive warm.*; \
    su texlive -s /bin/sh -c 'PAR_GLOBAL_TEMP=/opt/galley/par-cache biber warm >/dev/null'; \
    rm -f /tmp/warm.*; \
    printf 'galley:x:1000:1000::/tmp:/usr/sbin/nologin\n' > /opt/galley/passwd; \
    printf 'galley:x:1000:\n' > /opt/galley/group
COPY infra/compiler/latexmkrc /opt/galley/latexmkrc
WORKDIR /app
COPY --from=prod-deps --chown=texlive:texlive /repo/package.json ./
COPY --from=prod-deps --chown=texlive:texlive /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=texlive:texlive /repo/packages ./packages
COPY --from=prod-deps --chown=texlive:texlive /repo/apps/compiler ./apps/compiler
WORKDIR /app/apps/compiler
USER texlive
CMD ["node", "dist/server.js"]

FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
# Keep the workspace layout so the pnpm symlinks between packages stay valid.
COPY --from=prod-deps --chown=node:node /repo/package.json ./
COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /repo/packages ./packages
COPY --from=prod-deps --chown=node:node /repo/apps/${SERVICE} ./apps/${SERVICE}
# The API serves projects over Git (SPEC §6.7): git from the Alpine release of the Node
# image, and the folder of the git-data volume.
RUN if [ "$SERVICE" = api ]; then \
      apk add --no-cache git && install -d -o node -g node /var/lib/galley/git; \
    fi
WORKDIR /app/apps/${SERVICE}
USER node
CMD ["node", "dist/server.js"]
