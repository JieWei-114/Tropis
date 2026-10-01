# One Dockerfile, one image per role: build a role with `--target <role>`
# (public, private, worker, scheduler). Every role image carries only its own
# bundle (dist/<role>/, see esbuild.config.mjs) on the same production
# node_modules. The default target is `public`.
#
# Debian (glibc), not Alpine: @temporalio/core-bridge ships glibc binaries only,
# and the aerospike and pulsar-client prebuilds target glibc as well.

# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS builder

WORKDIR /app

# pnpm comes from the root package.json `packageManager` field.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Workspace manifests first, so the install layer is cached when only sources change.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/helm/package.json ./apps/frontend/helm/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY e2e/package.json ./e2e/

RUN pnpm install --frozen-lockfile --filter @tropis/backend...

COPY apps/backend/ ./apps/backend/
COPY packages/shared/ ./packages/shared/

# The backend depends on @tropis/shared's build output.
RUN pnpm --filter @tropis/shared build
RUN pnpm --filter @tropis/backend build

# ── Production dependencies ───────────────────────────────────────────────────
FROM node:26-bookworm-slim AS deps

WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/helm/package.json ./apps/frontend/helm/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY e2e/package.json ./e2e/

# The root "prepare: husky" script would fail here (husky is a
# devDependency), so strip it first.
RUN npm pkg delete scripts.prepare \
    && pnpm install --frozen-lockfile --prod --filter @tropis/backend...

# ── Runtime base shared by every role ─────────────────────────────────────────
# No package manager or store: only the installed tree and the built output.
FROM node:26-bookworm-slim AS runtime

# libyaml: the aerospike client's native addon links against it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libyaml-0-2 \
    && rm -rf /var/lib/apt/lists/*

# Numeric uid/gid so Kubernetes `runAsNonRoot` can verify the user.
RUN groupadd --gid 1001 appgroup \
    && useradd --uid 1001 --gid appgroup --no-create-home --shell /usr/sbin/nologin appuser

COPY --from=deps /app /app
COPY --from=builder /app/packages/shared/dist /app/packages/shared/dist

WORKDIR /app/apps/backend
USER 1001

# ── Roles ─────────────────────────────────────────────────────────────────────
FROM runtime AS scheduler
COPY --from=builder /app/apps/backend/dist/scheduler ./dist/scheduler
EXPOSE 9464
CMD ["node", "dist/scheduler/main.js"]

FROM runtime AS worker
COPY --from=builder /app/apps/backend/dist/worker ./dist/worker
EXPOSE 9464
CMD ["node", "dist/worker/main.js"]

FROM runtime AS private
COPY --from=builder /app/apps/backend/dist/private ./dist/private
EXPOSE 50061 9464
CMD ["node", "dist/private/main.js"]

FROM runtime AS public
COPY --from=builder /app/apps/backend/dist/public ./dist/public
EXPOSE 3100 50051 9464
CMD ["node", "dist/public/main.js"]
