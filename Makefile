# Tropis Monorepo — developer entrypoints
# Run `make` or `make help` to list targets.

COMPOSE := docker compose -f infra/docker/docker-compose.yml

# k6 runs in a container, so it cannot reach the backend on `localhost`:
# with --network host that is the container's own loopback on macOS/Windows
# Docker Desktop, and every scenario silently failed with "the body is null".
# `host.docker.internal` resolves to the host on Desktop, and --add-host maps
# it to the gateway on Linux, so one target works everywhere.
K6_BASE_URL ?= http://host.docker.internal:3100
K6_DOCKER_ARGS ?= --add-host=host.docker.internal:host-gateway

# The browser suite performs many real sign-ins from one IP (more still with
# E2E_ALL_BROWSERS=1), which trips the production-strength auth rate limit.
E2E_RATE_LIMIT_AUTH ?= 200
# Profiles: core services carry no profile and start by default.
# Optional groups: analytics (Flink), observability (OTel/Jaeger/Prometheus/Grafana), tools (web UIs),
# rust (signing service — not in ALL_PROFILES; start with: $(COMPOSE) --profile rust up -d).
ALL_PROFILES := --profile analytics --profile observability --profile tools

.DEFAULT_GOAL := help
.PHONY: help install dev up up-core up-all up-obs up-analytics up-tools down logs test test-int test-e2e load-test lint build seed promote-admin migrate proto backup restore rust-build rust-test android desktop pulsar-tail pulsar-send ws-listen outbox-status sdk-repl wf-demo k8s k8s-ui

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies + create local .env files from the examples
	pnpm install
	@test -f apps/backend/.env || (cp apps/backend/.env.example apps/backend/.env && echo "created apps/backend/.env from example")
	@test -f apps/frontend/helm/.env || (cp apps/frontend/helm/.env.example apps/frontend/helm/.env && echo "created apps/frontend/helm/.env from example")

dev: ## Run backend + frontend in watch mode (the Temporal worker runs in-process; `make worker` starts the standalone one)
	pnpm dev

up-core: ## Start ONLY the golden-path minimum (postgres, redis, clickhouse, pulsar, mongodb) — fastest, most reliable boot
	$(COMPOSE) up -d postgres redis clickhouse pulsar mongodb

up: ## Start core infrastructure (everything /api/health probes + mailhog; no UIs/Flink/observability)
	$(COMPOSE) up -d

up-all: ## Start the FULL stack — core + analytics + observability + tools (needs ~8GB+ Docker memory)
	$(COMPOSE) $(ALL_PROFILES) up -d

up-obs: ## Start core + observability profile (otel-collector, jaeger, prometheus, grafana)
	$(COMPOSE) --profile observability up -d

up-analytics: ## Start core + analytics profile (Flink jobmanager/taskmanager)
	$(COMPOSE) --profile analytics up -d

up-tools: ## Start core + tools profile (mongo-express, kibana, pgadmin, redisinsight, temporal-ui, …)
	$(COMPOSE) --profile tools up -d

down: ## Stop and remove all compose containers (all profiles)
	$(COMPOSE) $(ALL_PROFILES) down

logs: ## Tail logs from compose services (SERVICE=<name> for one service)
	$(COMPOSE) logs -f $(SERVICE)

test: ## Run unit tests across all packages
	pnpm -r test

test-int: ## Run backend integration suite (Testcontainers — needs Docker only)
	pnpm --filter @tropis/backend test:int

test-e2e: ## Full-stack E2E: compose up + backend + frontend preview + Playwright, then tear down
	$(COMPOSE) up -d
	pnpm --filter @tropis/backend test:e2e
	@test -f apps/backend/.env || cp apps/backend/.env.example apps/backend/.env
	pnpm --filter @tropis/backend build
	pnpm --filter @tropis/helm build
	@set -e; \
	RATE_LIMIT_AUTH=$(E2E_RATE_LIMIT_AUTH) pnpm --filter @tropis/backend start > /tmp/e2e-backend.log 2>&1 & echo $$! > /tmp/e2e-backend.pid; \
	echo "Waiting for backend health (http://localhost:3100/api/health)…"; \
	ok=0; for i in $$(seq 1 90); do curl -sf http://localhost:3100/api/health >/dev/null 2>&1 && { ok=1; break; }; sleep 2; done; \
	[ $$ok -eq 1 ] || { echo "backend never became healthy"; tail -50 /tmp/e2e-backend.log; kill $$(cat /tmp/e2e-backend.pid) 2>/dev/null; exit 1; }; \
	pnpm --filter @tropis/backend seed; \
	pnpm --filter @tropis/backend promote-admin admin@example.com; \
	pnpm --filter @tropis/helm preview --port 5173 --strictPort > /tmp/e2e-frontend.log 2>&1 & echo $$! > /tmp/e2e-frontend.pid; \
	for i in $$(seq 1 30); do curl -sf http://localhost:5173 >/dev/null 2>&1 && break; sleep 1; done; \
	status=0; pnpm --filter @tropis/e2e exec playwright test || status=$$?; \
	kill $$(cat /tmp/e2e-backend.pid) $$(cat /tmp/e2e-frontend.pid) 2>/dev/null || true; \
	rm -f /tmp/e2e-backend.pid /tmp/e2e-frontend.pid; \
	$(COMPOSE) down; \
	exit $$status

load-test: ## Run k6 load scenarios via docker (stack must be UP: make up + backend on :3100 + make seed; see load/README.md — never point at prod)
	@curl -sf http://localhost:3100/api/health >/dev/null 2>&1 || { echo "Backend not healthy at http://localhost:3100/api/health — start the stack first (make up + backend), see load/README.md"; exit 1; }
	@set -e; for s in health track-ingest login; do \
	  echo "── k6: $$s ──"; \
	  docker run --rm -i $(K6_DOCKER_ARGS) -e BASE_URL=$(K6_BASE_URL) grafana/k6 run - < load/scenarios/$$s.js; \
	done

lint: ## Lint all packages
	pnpm -r lint

build: ## Build all packages
	pnpm -r build

seed: ## Seed dev data via the running backend (20 users incl. admin@example.com as editor + 50 analytics events; then run promote-admin)
	pnpm --filter @tropis/backend seed

promote-admin: ## Grant the admin role to a user: make promote-admin EMAIL=<email> (runs against the DB, then re-login)
	@test -n "$(EMAIL)" || { echo "Usage: make promote-admin EMAIL=<email>"; exit 1; }
	EMAIL=$(EMAIL) pnpm --filter @tropis/backend promote-admin $(EMAIL)

# ── Dev tools (devtools/ — CLI tools; map in docs/dev-tools.md) ──────────────

pulsar-tail: ## Tail a Pulsar topic live: make pulsar-tail TOPIC=<name> (Ctrl-C to stop)
	@test -n "$(TOPIC)" || { echo "Usage: make pulsar-tail TOPIC=<topic name, e.g. user-events>"; exit 1; }
	@docker inspect -f '{{.State.Running}}' tropis_pulsar 2>/dev/null | grep -q true || { echo "Pulsar container (tropis_pulsar) is not running — start core infra first: make up"; exit 1; }
	docker exec -it tropis_pulsar bin/pulsar-client consume -s "dev-tail-$$$$" -n 0 "$(TOPIC)"

pulsar-send: ## Publish a message: make pulsar-send TOPIC=<name> MSG='{"hello":"world"}'
	@test -n "$(TOPIC)" && test -n "$(MSG)" || { echo "Usage: make pulsar-send TOPIC=<topic> MSG='<json>'"; exit 1; }
	@docker inspect -f '{{.State.Running}}' tropis_pulsar 2>/dev/null | grep -q true || { echo "Pulsar container (tropis_pulsar) is not running — start core infra first: make up"; exit 1; }
	docker exec tropis_pulsar bin/pulsar-client produce -m '$(MSG)' "$(TOPIC)"

ws-listen: ## Print every Socket.io /ws event live (TOKEN=<jwt> optional; defaults to logging in as the seeded editor admin@example.com)
	TOKEN=$(TOKEN) pnpm --filter @tropis/devtools ws-listen

outbox-status: ## Outbox snapshot: counts by status + oldest pending/failed rows (needs MongoDB: make up)
	pnpm --filter @tropis/devtools outbox-status

wf-demo: ## Demo the Temporal onboarding workflow (add CRASH=1 for the crash-recovery version)
	@cd apps/backend && ./scripts/temporal-demo.sh $(if $(CRASH),--crash,)

sdk-repl: ## Node REPL with the @tropis/sdk facade preloaded + logged in (needs make up + make dev + make seed)
	@curl -sf http://localhost:3100/api/health >/dev/null 2>&1 || { echo "Backend not healthy at http://localhost:3100/api/health — start it first: make up && make dev"; exit 1; }
	pnpm --filter @tropis/devtools sdk-repl

# ── Local Kubernetes (kind) — visualise the cluster ──────────────────────────
K8S_CTX ?= kind-tropis
K8S_NS  ?= tropis

k8s: ## k9s — terminal UI for the local kind cluster (auto-installs via brew)
	@kubectl config get-contexts $(K8S_CTX) >/dev/null 2>&1 || { echo "No '$(K8S_CTX)' context — create it first: kind create cluster --name tropis"; exit 1; }
	@command -v k9s >/dev/null 2>&1 || { echo "Installing k9s…"; brew install k9s; }
	k9s --context $(K8S_CTX) -n $(K8S_NS)

k8s-ui: ## Headlamp — browser/desktop UI for the kind cluster (auto-installs via brew cask)
	@kubectl config get-contexts $(K8S_CTX) >/dev/null 2>&1 || { echo "No '$(K8S_CTX)' context — create it first: kind create cluster --name tropis"; exit 1; }
	@ls -d /Applications/Headlamp.app >/dev/null 2>&1 || { echo "Installing Headlamp…"; brew install --cask headlamp; }
	@echo "Opening Headlamp — pick the '$(K8S_CTX)' context in the app (namespace: $(K8S_NS))."
	@open -a Headlamp

proto: ## Regenerate SDK types from the v1 protos (buf → packages/sdk/src/gen)
	npx @bufbuild/buf generate

rust-build: ## Build the Rust services (Cargo workspace at services/rust/)
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found — install the Rust toolchain via https://rustup.rs (then: . \$$HOME/.cargo/env)"; exit 1; }
	cd services/rust && cargo build --release --workspace

rust-test: ## Test the Rust services (fmt + clippy + tests, incl. the shared HMAC vector)
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found — install the Rust toolchain via https://rustup.rs (then: . \$$HOME/.cargo/env)"; exit 1; }
	cd services/rust && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace

android: ## Build web app + sync into the Capacitor Android project (then open in Android Studio)
	pnpm --filter @tropis/helm build
	pnpm --filter @tropis/helm cap:sync android
	@echo ""
	@echo "Android project synced (apps/frontend/helm/android/)."
	@echo "Compile/run needs Android Studio + SDK: pnpm --filter @tropis/helm cap:android"
	@echo "Device builds: point VITE_* in apps/frontend/helm/.env at your LAN IP first — see docs/multi-platform.md"

desktop: ## Build the Tauri desktop app (.app/.dmg/.exe/.deb under apps/desktop/src-tauri/target/)
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found — install the Rust toolchain via https://rustup.rs (then: . \$$HOME/.cargo/env)"; exit 1; }
	# `bundle` is the packaging script; the workspace's plain `build` is
	# --no-bundle so `pnpm -r build` does not need per-OS installer tooling.
	pnpm --filter @tropis/desktop run bundle

migrate: ## Run PostgreSQL migrations up (node-pg-migrate)
	pnpm --filter @tropis/backend migrate:up

backup: ## Dump MongoDB + PostgreSQL + ClickHouse to ./backups/<timestamp>/ (see infra/backup/backup.sh)
	./infra/backup/backup.sh

restore: ## Restore from a backup: make restore TS=<timestamp> (destructive, prompts for confirmation)
	./infra/backup/restore.sh $(TS)
