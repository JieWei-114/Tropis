# Tropis Monorepo — developer entrypoints
# Run `make` or `make help` to list targets.

COMPOSE := docker compose -f infra/docker/docker-compose.yml
# Profiles: core services carry no profile and start by default.
# Optional groups: analytics (Flink), observability (OTel/Jaeger/Prometheus/Grafana), tools (web UIs),
# rust (signing service — not in ALL_PROFILES; start with: $(COMPOSE) --profile rust up -d).
ALL_PROFILES := --profile analytics --profile observability --profile tools

.DEFAULT_GOAL := help
.PHONY: help install dev up up-all up-obs up-analytics up-tools down logs test test-int test-e2e load-test lint build seed migrate proto backup restore rust-build rust-test android desktop pulsar-tail pulsar-send ws-listen outbox-status sdk-repl k8s k8s-ui

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies + create local .env files from the examples
	pnpm install
	@test -f apps/backend/.env || (cp apps/backend/.env.example apps/backend/.env && echo "created apps/backend/.env from example")
	@test -f apps/frontend/helm/.env || (cp apps/frontend/helm/.env.example apps/frontend/helm/.env && echo "created apps/frontend/helm/.env from example")

dev: ## Run backend + frontend + temporal worker in watch mode
	pnpm dev

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
	pnpm --filter @tropis/backend start > /tmp/e2e-backend.log 2>&1 & echo $$! > /tmp/e2e-backend.pid; \
	echo "Waiting for backend health (http://localhost:3100/api/health)…"; \
	ok=0; for i in $$(seq 1 90); do curl -sf http://localhost:3100/api/health >/dev/null 2>&1 && { ok=1; break; }; sleep 2; done; \
	[ $$ok -eq 1 ] || { echo "backend never became healthy"; tail -50 /tmp/e2e-backend.log; kill $$(cat /tmp/e2e-backend.pid) 2>/dev/null; exit 1; }; \
	pnpm --filter @tropis/helm preview --port 5173 --strictPort > /tmp/e2e-frontend.log 2>&1 & echo $$! > /tmp/e2e-frontend.pid; \
	for i in $$(seq 1 30); do curl -sf http://localhost:5173 >/dev/null 2>&1 && break; sleep 1; done; \
	status=0; pnpm --filter @tropis/e2e exec playwright test || status=$$?; \
	kill $$(cat /tmp/e2e-backend.pid) $$(cat /tmp/e2e-frontend.pid) 2>/dev/null || true; \
	rm -f /tmp/e2e-backend.pid /tmp/e2e-frontend.pid; \
	$(COMPOSE) down; \
	exit $$status

load-test: ## Run k6 load scenarios via docker (stack must be UP: make up + backend on :3100 + make seed; see load/README.md — never point at prod)
	@curl -sf http://localhost:3100/api/health >/dev/null 2>&1 || { echo "Backend not healthy at http://localhost:3100/api/health — start the stack first (make up + backend), see load/README.md"; exit 1; }
	docker run --rm -i --network host grafana/k6 run - < load/scenarios/health.js
	docker run --rm -i --network host grafana/k6 run - < load/scenarios/track-ingest.js
	docker run --rm -i --network host grafana/k6 run - < load/scenarios/login.js

lint: ## Lint all packages
	pnpm -r lint

build: ## Build all packages
	pnpm -r build

seed: ## Seed dev data via the running backend (admin + 20 users + 50 analytics events)
	pnpm --filter @tropis/backend seed

# ── Dev tools (devtools/ — CLI tools; map in docs/dev-tools.md) ──────────────

pulsar-tail: ## Tail a Pulsar topic live: make pulsar-tail TOPIC=<name> (Ctrl-C to stop)
	@test -n "$(TOPIC)" || { echo "Usage: make pulsar-tail TOPIC=<topic name, e.g. user-events>"; exit 1; }
	@docker inspect -f '{{.State.Running}}' tropis_pulsar 2>/dev/null | grep -q true || { echo "Pulsar container (tropis_pulsar) is not running — start core infra first: make up"; exit 1; }
	docker exec -it tropis_pulsar bin/pulsar-client consume -s "dev-tail-$$$$" -n 0 "$(TOPIC)"

pulsar-send: ## Publish a message: make pulsar-send TOPIC=<name> MSG='{"hello":"world"}'
	@test -n "$(TOPIC)" && test -n "$(MSG)" || { echo "Usage: make pulsar-send TOPIC=<topic> MSG='<json>'"; exit 1; }
	@docker inspect -f '{{.State.Running}}' tropis_pulsar 2>/dev/null | grep -q true || { echo "Pulsar container (tropis_pulsar) is not running — start core infra first: make up"; exit 1; }
	docker exec tropis_pulsar bin/pulsar-client produce -m '$(MSG)' "$(TOPIC)"

ws-listen: ## Print every Socket.io /ws event live (TOKEN=<jwt> optional; defaults to logging in as the seeded admin)
	TOKEN=$(TOKEN) pnpm --filter @tropis/devtools ws-listen

outbox-status: ## Outbox snapshot: counts by status + oldest pending/failed rows (needs MongoDB: make up)
	pnpm --filter @tropis/devtools outbox-status

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
	pnpm --filter @tropis/desktop exec tauri build

migrate: ## Run PostgreSQL migrations up (node-pg-migrate)
	pnpm --filter @tropis/backend migrate:up

backup: ## Dump MongoDB + PostgreSQL + ClickHouse to ./backups/<timestamp>/ (see infra/backup/backup.sh)
	./infra/backup/backup.sh

restore: ## Restore from a backup: make restore TS=<timestamp> (destructive, prompts for confirmation)
	./infra/backup/restore.sh $(TS)
