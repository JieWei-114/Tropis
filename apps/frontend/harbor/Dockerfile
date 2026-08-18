# Build from the repo root (pnpm workspace):
#   docker build -f apps/frontend/harbor/Dockerfile .
#
# Harbor is the PUBLIC site (Next.js App Router, SSR/SSG). Unlike helm — which
# ships as static files behind nginx — harbor is a long-running Node server, so
# the runtime image carries a self-contained Next.js "standalone" server.

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests first — Docker layer cache skips install
# when only source files change.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/frontend/harbor/package.json ./apps/frontend/harbor/
COPY apps/frontend/helm/package.json ./apps/frontend/helm/
COPY apps/backend/package.json ./apps/backend/
COPY apps/temporal-worker/package.json ./apps/temporal-worker/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY e2e/package.json ./e2e/

RUN pnpm install --frozen-lockfile --filter @tropis/harbor...

# Copy source and build. `output: 'standalone'` (next.config.mjs) emits a
# self-contained server under .next/standalone that traces only the deps it needs.
COPY apps/frontend/harbor/ ./apps/frontend/harbor/

RUN pnpm --filter @tropis/harbor build

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:22-alpine AS runner

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
