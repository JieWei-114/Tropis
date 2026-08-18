# Build from the repo root (pnpm workspace):
#   docker build -f apps/frontend/helm/Dockerfile .

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:26-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests first — Docker layer cache skips install
# when only source files change
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/frontend/helm/package.json ./apps/frontend/helm/
COPY apps/backend/package.json ./apps/backend/
COPY apps/temporal-worker/package.json ./apps/temporal-worker/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY e2e/package.json ./e2e/

RUN pnpm install --frozen-lockfile --filter @tropis/helm...

# Copy source (frontend + the workspace packages it consumes as raw TS)
COPY apps/frontend/helm/ ./apps/frontend/helm/
COPY packages/sdk/ ./packages/sdk/
COPY packages/shared/ ./packages/shared/

# Vite inlines these at build time
ARG VITE_API_BASE_URL
ARG VITE_WS_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_WS_URL=$VITE_WS_URL

RUN pnpm --filter @tropis/helm build

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM nginx:alpine AS runner

# SPA-aware nginx config (fallback to index.html, gzip)
COPY apps/frontend/helm/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/apps/frontend/helm/dist /usr/share/nginx/html

# Runs fine as the non-root "nginx" user (uid 101): listens on 8080 and the
# K8s deployment mounts emptyDir volumes over /var/cache/nginx and /var/run.
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
