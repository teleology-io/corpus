# syntax=docker/dockerfile:1
#
# One image for every Corpus process. The compose file (deploy/compose.yml) picks the process
# with `command`, so web, admin, worker, collab and migrations always run the same build.
#
#   docker build -t corpus .
#
# All configuration is read at runtime from environment variables; nothing is baked in.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# ── Dependencies: only manifests, so this layer is cached until a lockfile/package.json changes.
FROM base AS deps
# node-pty (Workbench terminals) compiles a native addon.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/worker/package.json apps/worker/
COPY apps/collab/package.json apps/collab/
COPY packages/auth/package.json packages/auth/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ── Speech model for note dictation and Telescope transcripts (~175MB from GitHub releases).
# Own stage keyed only on the fetch script, so source changes never re-download it.
FROM base AS asr
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-asr-model.mjs scripts/
RUN node scripts/fetch-asr-model.mjs

# ── Build the two SvelteKit apps. Worker and collab run TypeScript directly through tsx.
FROM deps AS build
COPY . .
# Served as static files by the web app (apps/web/static/sherpa/<version>).
COPY --from=asr /app/apps/web/static/sherpa apps/web/static/sherpa
# SvelteKit's post-build analysis imports server modules, and @corpus/db reads DATABASE_URL on
# import. postgres.js connects lazily, so a placeholder (this step only) is never dialled.
RUN DATABASE_URL=postgres://build:build@127.0.0.1:1/build \
	pnpm --filter web build && \
	DATABASE_URL=postgres://build:build@127.0.0.1:1/build pnpm --filter admin build && \
	# The build copied the speech model into build/client; drop the source copy (~200MB).
	rm -rf apps/web/static/sherpa

# ── Runtime
FROM base AS runtime
# git: Workbench runs it. tini: forwards SIGTERM so the worker shuts pg-boss down cleanly.
RUN apt-get update && apt-get install -y --no-install-recommends git tini ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
# Default process: the web app. Override per service in compose.
WORKDIR /app/apps/web
EXPOSE 2222
CMD ["node", "build"]
