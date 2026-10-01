# Build from the repo root (pnpm workspace):
#   docker build -f apps/frontend/helm/Dockerfile .

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# pnpm comes from the root package.json `packageManager` field.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Copy workspace manifests first — Docker layer cache skips install
# when only source files change
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/frontend/helm/package.json ./apps/frontend/helm/
COPY apps/backend/package.json ./apps/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY e2e/package.json ./e2e/

RUN pnpm install --frozen-lockfile --filter @tropis/helm...

# Copy source (frontend + the workspace packages it consumes as raw TS)
COPY apps/frontend/helm/ ./apps/frontend/helm/
COPY packages/sdk/ ./packages/sdk/
COPY packages/shared/ ./packages/shared/

# Vite inlines these at build time, so each image is bound to the endpoints it
# was built with. No defaults here: an unset or empty value makes
# src/lib/env.ts fall back to its local-dev default and log a warning.
ARG VITE_API_BASE_URL
ARG VITE_RPC_URL
ARG VITE_WS_URL
ARG VITE_SITE_URL
ARG VITE_TENANT_ID
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_RPC_URL=$VITE_RPC_URL \
    VITE_WS_URL=$VITE_WS_URL \
    VITE_SITE_URL=$VITE_SITE_URL \
    VITE_TENANT_ID=$VITE_TENANT_ID

# `tsc -b` resolves @tropis/shared's types from its build output.
RUN pnpm --filter @tropis/shared build
RUN pnpm --filter @tropis/helm build
# The CSP's connect-src names the same endpoints the bundle was built with,
# and the build fails if the inline-script hash in nginx.conf is stale.
RUN node apps/frontend/helm/scripts/render-nginx-conf.mjs \
      apps/frontend/helm/nginx.conf apps/frontend/helm/dist/index.html \
      > /app/nginx.conf

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM nginx:alpine AS runner

# SPA-aware nginx config (fallback to index.html, gzip, security headers),
# rendered for this build's endpoints in the builder stage
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/apps/frontend/helm/dist /usr/share/nginx/html

# Runs fine as the non-root "nginx" user (uid 101): listens on 8080 and the
# K8s deployment mounts emptyDir volumes over /var/cache/nginx and /var/run.
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
