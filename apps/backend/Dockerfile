# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests first — Docker layer cache skips npm install
# when only source files change
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY frontend/helm/package.json ./frontend/helm/
COPY apps/temporal-worker/package.json ./apps/temporal-worker/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY e2e/package.json ./e2e/

RUN pnpm install --frozen-lockfile --filter @tropis/backend...

# Copy source
COPY apps/backend/ ./apps/backend/
COPY packages/shared/ ./packages/shared/

# Build shared package first (backend depends on it)
RUN pnpm --filter @tropis/shared build
RUN pnpm --filter @tropis/backend build

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY frontend/helm/package.json ./frontend/helm/
COPY apps/temporal-worker/package.json ./apps/temporal-worker/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY e2e/package.json ./e2e/

# Production deps only — no devDependencies. The root "prepare: husky" script
# would fail here (husky is a devDependency), so strip it first.
RUN npm pkg delete scripts.prepare \
    && pnpm install --frozen-lockfile --prod --filter @tropis/backend...

# Copy compiled output from builder
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Copy proto contracts (repo root; loaded at runtime by gRPC)
COPY proto ./proto

WORKDIR /app/apps/backend

# Non-root user for security. Pin a NUMERIC uid/gid and reference it numerically
# in USER so Kubernetes `runAsNonRoot` can verify the user is non-root (a named
# user like "appuser" is unverifiable and fails with CreateContainerConfigError).
RUN addgroup -S -g 1001 appgroup && adduser -S -u 1001 appuser -G appgroup
USER 1001

EXPOSE 3100 50051

CMD ["node", "dist/main"]
