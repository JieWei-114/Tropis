# Tropis Monorepo — developer entrypoints
# Run `make` or `make help` to list targets.

COMPOSE := docker compose -f infra/docker/docker-compose.yml

# k6 runs in a container, so it cannot reach the backend on `localhost`:
# with --network host that is the container's own loopback on macOS/Windows
# Docker Desktop, and every scenario silently failed with "the body is null".
# `host.docker.internal` resolves to the host on Desktop, and --add-host maps
# it to the gateway on Linux, so one target works everywhere.
K6_BASE_URL ?= http://host.docker.internal:3100
K6_OPS_URL ?= http://host.docker.internal:9464
K6_TENANT_ID ?= dev
K6_DOCKER_ARGS ?= --add-host=host.docker.internal:host-gateway

# The browser suite performs many real sign-ins from one IP (more still with
# E2E_ALL_BROWSERS=1), which trips the production-strength auth rate limit.
E2E_RATE_LIMIT_AUTH ?= 200
E2E_SIGNUP_RATE_LIMIT ?= 1000
# Compose tiers (see the header of infra/docker/docker-compose.yml).
# Core services carry no profile and always start. BACKEND_PROFILES adds every
# capability the backend still requires at boot, so `make up` gives a working
# backend; ALL_PROFILES is every profile in the file.
BACKEND_PROFILES := --profile relational --profile search --profile olap --profile objects --profile workflow --profile secrets --profile kv-scale
ALL_PROFILES := --profile '*'
# One-shot init containers exit when done, which `up --wait` reports as a
# failure, so readiness waits name every other service instead.
COMPOSE_ONESHOTS := mongo-rs-reconfig|vault-init
COMPOSE_WAIT_TIMEOUT ?= 300

.DEFAULT_GOAL := help
.PHONY: help install dev up up-core up-all up-graph up-kafka up-stream up-signing up-obs up-tools down logs test test-int test-e2e load-test lint build seed promote-admin tenant-create migrate proto backup restore rust-build rust-test android desktop pulsar-tail pulsar-send ws-listen outbox-status outbox-dead outbox-redrive outbox-skip jobs-dlq jobs-dlq-replay messaging-dlq messaging-dlq-redrive sdk-repl wf-demo k8s k8s-ui

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies + create local .env files from the examples
	pnpm install
	@test -f apps/backend/.env || (cp apps/backend/.env.example apps/backend/.env && echo "created apps/backend/.env from example")
	@test -f apps/frontend/helm/.env || (cp apps/frontend/helm/.env.example apps/frontend/helm/.env && echo "created apps/frontend/helm/.env from example")

dev: ## Run backend (every role in one process) + frontend in watch mode
	pnpm dev

up-core: ## Start only the core tier (mongodb, redis, pulsar, opa, mailpit); the backend does not boot on it alone yet
	$(COMPOSE) up -d

up: ## Start core + every capability the backend needs today (relational, search, olap, objects, workflow, secrets, kv-scale)
	$(COMPOSE) $(BACKEND_PROFILES) up -d

up-all: ## Start every profile: all capabilities + stream + signing + observability + tools (needs ~8GB+ Docker memory)
	$(COMPOSE) $(ALL_PROFILES) up -d

up-graph: ## Start core + Neo4j (graph profile; Browser at http://localhost:7474, Bolt on 7687)
	$(COMPOSE) --profile graph up -d

up-kafka: ## Start core + single-node Kafka in KRaft mode (kafka profile, localhost:9092)
	$(COMPOSE) --profile kafka up -d

up-stream: ## Start core + Flink jobmanager/taskmanager (stream profile; jobs live in services/flink)
	$(COMPOSE) --profile stream up -d

up-signing: ## Build and start core + the Rust signing service (signing profile, :50052)
	$(COMPOSE) --profile signing up -d --build

up-obs: ## Start core + observability profile (otel-collector, jaeger, prometheus, alertmanager, grafana)
	$(COMPOSE) --profile observability up -d

up-tools: ## Start the `make up` stack + tools profile (mongo-express, kibana, pgadmin, redisinsight, temporal-ui, …)
	$(COMPOSE) $(BACKEND_PROFILES) --profile tools up -d

down: ## Stop and remove all compose containers (all profiles)
	$(COMPOSE) $(ALL_PROFILES) down

logs: ## Tail logs from compose services (SERVICE=<name> for one service)
	$(COMPOSE) logs -f $(SERVICE)

test: ## Run unit tests across all packages
	pnpm -r test

test-int: ## Run backend integration suite (Testcontainers — needs Docker only)
	pnpm --filter @tropis/backend test:int

test-e2e: ## Full-stack E2E: compose up + backend + frontend preview + Playwright, then tear down (always, via trap)
	@set -eu; \
	be_pid=; fe_pid=; logs="$${TMPDIR:-/tmp}"; \
	cleanup() { \
	  status=$$?; trap - EXIT INT TERM; \
	  [ -z "$$fe_pid" ] || kill "$$fe_pid" 2>/dev/null || true; \
	  [ -z "$$be_pid" ] || kill "$$be_pid" 2>/dev/null || true; \
	  [ "$$status" -eq 0 ] || [ -z "$$be_pid" ] || { echo "── backend log (last 50 lines) ──"; tail -50 "$$logs/e2e-backend.log" 2>/dev/null || true; }; \
	  $(COMPOSE) $(BACKEND_PROFILES) down; \
	  exit "$$status"; \
	}; \
	trap cleanup EXIT; trap 'exit 130' INT TERM; \
	$(COMPOSE) $(BACKEND_PROFILES) up -d; \
	$(COMPOSE) $(BACKEND_PROFILES) up -d --wait --wait-timeout $(COMPOSE_WAIT_TIMEOUT) \
	  $$($(COMPOSE) $(BACKEND_PROFILES) config --services | grep -vxE '$(COMPOSE_ONESHOTS)'); \
	test -f apps/backend/.env || cp apps/backend/.env.example apps/backend/.env; \
	pnpm --filter @tropis/backend migrate:up; \
	pnpm --filter @tropis/backend test:e2e; \
	pnpm --filter @tropis/backend build; \
	pnpm --filter @tropis/helm build; \
	(cd apps/backend && RATE_LIMIT_AUTH=$(E2E_RATE_LIMIT_AUTH) SIGNUP_RATE_LIMIT_IP=$(E2E_SIGNUP_RATE_LIMIT) SIGNUP_RATE_LIMIT_TENANT=$(E2E_SIGNUP_RATE_LIMIT) exec node dist/main.js) > "$$logs/e2e-backend.log" 2>&1 & be_pid=$$!; \
	echo "Waiting for backend readiness (http://localhost:9464/readyz)…"; \
	ok=0; for i in $$(seq 1 90); do curl -sf http://localhost:9464/readyz >/dev/null 2>&1 && { ok=1; break; }; sleep 2; done; \
	[ "$$ok" -eq 1 ] || { echo "backend never became ready"; exit 1; }; \
	pnpm --filter @tropis/backend seed; \
	(cd apps/frontend/helm && exec node_modules/.bin/vite preview --port 5173 --strictPort) > "$$logs/e2e-frontend.log" 2>&1 & fe_pid=$$!; \
	ok=0; for i in $$(seq 1 30); do curl -sf http://localhost:5173 >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done; \
	[ "$$ok" -eq 1 ] || { echo "helm preview never answered"; tail -20 "$$logs/e2e-frontend.log"; exit 1; }; \
	pnpm --filter @tropis/e2e exec playwright test

load-test: ## Run k6 load scenarios via docker (stack must be UP: make up + backend on :3100 + make seed; see load/README.md — never point at prod)
	@curl -sf http://localhost:3100/api/health >/dev/null 2>&1 || { echo "Backend not healthy at http://localhost:3100/api/health — start the stack first (make up + backend), see load/README.md"; exit 1; }
	@set -e; for s in health track-ingest login; do \
	  echo "── k6: $$s ──"; \
	  docker run --rm -i $(K6_DOCKER_ARGS) -e BASE_URL=$(K6_BASE_URL) -e OPS_URL=$(K6_OPS_URL) -e TENANT_ID=$(K6_TENANT_ID) grafana/k6 run - < load/scenarios/$$s.js; \
	done

lint: ## Lint all packages
	pnpm -r lint

build: ## Build all packages
	pnpm -r build

seed: ## Seed dev data via the running backend (registers tenant dev with self sign-up, admin@example.com as admin, 20 demo users, 50 analytics events)
	pnpm --filter @tropis/backend seed

promote-admin: ## Grant the admin role to a user: make promote-admin EMAIL=<email> [TENANT_ID=dev] (runs against the DB)
	@test -n "$(EMAIL)" || { echo "Usage: make promote-admin EMAIL=<email> [TENANT_ID=dev]"; exit 1; }
	EMAIL=$(EMAIL) pnpm --filter @tropis/backend promote-admin $(EMAIL) $(or $(TENANT_ID),dev)

tenant-create: ## Register or update a tenant: make tenant-create ID=<tenant> NAME=<name> [SELF_SIGNUP=true] [STATUS=active|suspended] (runs against the DB)
	@test -n "$(ID)" || { echo "Usage: make tenant-create ID=<tenant> NAME=<name> [SELF_SIGNUP=true] [STATUS=active|suspended]"; exit 1; }
	pnpm --filter @tropis/backend tenant-create "$(ID)" "$(or $(NAME),$(ID))" "$(or $(SELF_SIGNUP),false)" "$(or $(STATUS),active)"

# ── Dev tools (devtools/ — CLI tools; map in docs/development.md#dev-tools) ──────────────

pulsar-tail: ## Tail a Pulsar topic live: make pulsar-tail TOPIC=<name> (Ctrl-C to stop)
	@test -n "$(TOPIC)" || { echo "Usage: make pulsar-tail TOPIC=<topic name, e.g. user-events>"; exit 1; }
	@docker inspect -f '{{.State.Running}}' tropis_pulsar 2>/dev/null | grep -q true || { echo "Pulsar container (tropis_pulsar) is not running — start core infra first: make up"; exit 1; }
	docker exec -it tropis_pulsar bin/pulsar-client consume -s "dev-tail-$$$$" -n 0 "$(TOPIC)"

pulsar-send: ## Publish a message: make pulsar-send TOPIC=<name> MSG='{"hello":"world"}'
	@test -n "$(TOPIC)" && test -n "$(MSG)" || { echo "Usage: make pulsar-send TOPIC=<topic> MSG='<json>'"; exit 1; }
	@docker inspect -f '{{.State.Running}}' tropis_pulsar 2>/dev/null | grep -q true || { echo "Pulsar container (tropis_pulsar) is not running — start core infra first: make up"; exit 1; }
	docker exec tropis_pulsar bin/pulsar-client produce -m '$(MSG)' "$(TOPIC)"

ws-listen: ## Print every Socket.io /ws event live (TOKEN=<jwt> optional; defaults to logging in as the seeded admin admin@example.com)
	TOKEN=$(TOKEN) pnpm --filter @tropis/devtools ws-listen

outbox-status: ## Outbox snapshot: counts by status + oldest pending/failed rows (needs MongoDB: make up)
	pnpm --filter @tropis/devtools outbox-status

outbox-dead: ## List DEAD outbox rows (each blocks its aggregate until redriven or skipped)
	pnpm --filter @tropis/devtools outbox-dead list

outbox-redrive: ## Put DEAD outbox rows back to pending: make outbox-redrive ID=<row id> | AGGREGATE=<id>
	@test -n "$(ID)$(AGGREGATE)" || { echo "Usage: make outbox-redrive ID=<row id> | AGGREGATE=<aggregate id>"; exit 1; }
	ID=$(ID) AGGREGATE=$(AGGREGATE) pnpm --filter @tropis/devtools outbox-dead redrive

outbox-skip: ## Give up DEAD outbox rows so their aggregate flows again: make outbox-skip ID=<row id> | AGGREGATE=<id>
	@test -n "$(ID)$(AGGREGATE)" || { echo "Usage: make outbox-skip ID=<row id> | AGGREGATE=<aggregate id>"; exit 1; }
	ID=$(ID) AGGREGATE=$(AGGREGATE) pnpm --filter @tropis/devtools outbox-dead skip

jobs-dlq: ## List dead-lettered jobs
	pnpm --filter @tropis/devtools jobs-dlq list

jobs-dlq-replay: ## Replay one dead-lettered job: make jobs-dlq-replay ID=<dlq job id>
	@test -n "$(ID)" || { echo "Usage: make jobs-dlq-replay ID=<dlq job id>"; exit 1; }
	ID=$(ID) pnpm --filter @tropis/devtools jobs-dlq replay

messaging-dlq: ## List dead-lettered messages: make messaging-dlq TOPIC=<topic> SUB=<subscription>
	@test -n "$(TOPIC)" && test -n "$(SUB)" || { echo "Usage: make messaging-dlq TOPIC=<topic> SUB=<subscription>"; exit 1; }
	TOPIC=$(TOPIC) SUB=$(SUB) pnpm --filter @tropis/devtools messaging-dlq list

messaging-dlq-redrive: ## Republish dead-lettered messages: make messaging-dlq-redrive TOPIC=<topic> SUB=<subscription> [COUNT=n]
	@test -n "$(TOPIC)" && test -n "$(SUB)" || { echo "Usage: make messaging-dlq-redrive TOPIC=<topic> SUB=<subscription> [COUNT=n]"; exit 1; }
	TOPIC=$(TOPIC) SUB=$(SUB) COUNT=$(or $(COUNT),1) pnpm --filter @tropis/devtools messaging-dlq redrive

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

proto: ## Regenerate the protobuf + Connect types (buf generate → packages/sdk/src/gen and apps/backend/src/gen)
	packages/sdk/node_modules/.bin/buf generate

rust-build: ## Build the Rust services (Cargo workspace at the repo root)
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found — install the Rust toolchain via https://rustup.rs (then: . \$$HOME/.cargo/env)"; exit 1; }
	cargo build --release --workspace

rust-test: ## Test the Rust services (fmt + clippy + tests, incl. the shared HMAC vector)
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found — install the Rust toolchain via https://rustup.rs (then: . \$$HOME/.cargo/env)"; exit 1; }
	cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace

android: ## Build web app + sync into the Capacitor Android project (then open in Android Studio)
	pnpm --filter @tropis/helm build
	pnpm --filter @tropis/helm cap:sync android
	@echo ""
	@echo "Android project synced (apps/frontend/helm/android/)."
	@echo "Compile/run needs Android Studio + SDK: pnpm --filter @tropis/helm cap:android"
	@echo "Device builds: point VITE_* in apps/frontend/helm/.env at your LAN IP first — see docs/deployment.md#build-time-endpoints"

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
