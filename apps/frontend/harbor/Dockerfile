# Build from the repo root (pnpm workspace):
#   docker build -f apps/frontend/harbor/Dockerfile .
#
# Harbor is the PUBLIC site (Next.js App Router, SSR/SSG). Unlike helm — which
# ships as static files behind nginx — harbor is a long-running Node server, so
# the runtime image carries a self-contained Next.js "standalone" server.

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:26-alpine AS builder

WORKDIR /app

# pnpm comes from the root package.json `packageManager` field.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Copy workspace manifests first — Docker layer cache skips install
# when only source files change.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/frontend/harbor/package.json ./apps/frontend/harbor/
COPY apps/frontend/helm/package.json ./apps/frontend/helm/
COPY apps/backend/package.json ./apps/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY e2e/package.json ./e2e/

RUN pnpm install --frozen-lockfile --filter @tropis/harbor...

# Copy source and build. `output: 'standalone'` (next.config.mjs) emits a
# self-contained server under .next/standalone that traces only the deps it needs.
COPY apps/frontend/harbor/ ./apps/frontend/harbor/

# Next.js inlines NEXT_PUBLIC_* at build time and prerenders pages with them
# (lib/site.ts: canonical/OG URLs and the console link), so each image is bound
# to the URLs it was built with. Build args reach RUN as environment variables.
# lib/site.ts falls back to its local-dev default only when a variable is
# absent, not when it is empty, so an arg passed empty is unset before the build.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_CONSOLE_URL

RUN [ -n "$NEXT_PUBLIC_SITE_URL" ] || unset NEXT_PUBLIC_SITE_URL; \
    [ -n "$NEXT_PUBLIC_CONSOLE_URL" ] || unset NEXT_PUBLIC_CONSOLE_URL; \
    pnpm --filter @tropis/harbor build

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:26-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Non-root runtime user
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -G nodejs -S nextjs

# The standalone output mirrors the monorepo layout: the entrypoint ends up at
# apps/frontend/harbor/server.js, with node_modules traced at the root. Static
# assets and public/ must be copied alongside it — Next does not bundle those.
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/harbor/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/harbor/.next/static ./apps/frontend/harbor/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/harbor/public ./apps/frontend/harbor/public

USER nextjs

EXPOSE 4000

CMD ["node", "apps/frontend/harbor/server.js"]
