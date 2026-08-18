# Deployment Runbook

## Prerequisites

- Docker + Docker Compose, `kubectl`, `kustomize` (bundled in kubectl), access to the target cluster
- GHCR access (images are public-repo GHCR: `ghcr.io/<org>/<repo>/{backend,frontend,harbor}`)
- `pnpm@10`, Node 22 (matching CI)
- Production only: cert-manager, ingress controller (nginx), External Secrets Operator, Vault reachable from the cluster

## From local to production — the ladder

You do not jump straight to a production cluster. Climb these; everything up to
production is **$0 and local**, and the safest place to learn — break it, `delete`,
recreate.

| Rung                    | Tool                                      | Proves                                                                                   | Cost |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- | ---- |
| **1. Docker Compose**   | `make up` / `make dev` / `make seed`      | The whole pipeline runs (login → gRPC → Mongo → Pulsar → Flink → ClickHouse → dashboard) | $0   |
| **2. Local Kubernetes** | `kind` + `kubectl`                        | You can deploy & operate it the way prod does                                            | $0   |
| **3. Production**       | a real cluster + the rest of this runbook | Real users, scale, failure survival                                                      | $$   |

### Rung 1 — Docker Compose (daily dev)

```bash
nvm use && make install
make up            # every datastore/broker the health check probes (~8 GB Docker mem)
make dev           # backend (:3100 / :50051) + frontend (:5173) + worker
make seed          # admin@example.com / Password123!
```

### Rung 2 — Local Kubernetes with `kind` (learn the ops stack, free)

`kind` runs a real cluster inside Docker — same manifests, same `kubectl`, same
failure modes as prod. Raise Docker Desktop memory to **12–16 GB** before adding
the backend + datastores (frontend-only fits in ~8 GB). Install: `brew install kind kubernetes-cli`.

```bash
kind create cluster --name tropis
kubectl get nodes                                    # wait for Ready

# Build the app image and load it INTO the cluster (kind has its own image
# store, separate from host Docker — images must be loaded explicitly).
# There are TWO frontends: helm (admin SPA, static/nginx) + harbor (public
# Next.js SSR). Build/load whichever you need:
docker build -f apps/frontend/helm/Dockerfile   -t tropis/frontend:local .
docker build -f apps/frontend/harbor/Dockerfile -t tropis/harbor:local .
kind load docker-image tropis/frontend:local --name tropis
kind load docker-image tropis/harbor:local   --name tropis

kubectl create namespace tropis
# Whole base (backend + helm + harbor + envoy + policies) in one shot:
kubectl apply -k infra/k8s/base
kubectl set image deployment/frontend frontend=tropis/frontend:local -n tropis
kubectl set image deployment/harbor   harbor=tropis/harbor:local     -n tropis
kubectl port-forward svc/frontend-svc -n tropis 8088:80   # helm  → http://localhost:8088
kubectl port-forward svc/harbor-svc   -n tropis 8089:80   # harbor → http://localhost:8089
```

**The gotcha you WILL hit — `ImagePullBackOff`.** The base manifest image is
tagged `:latest`, and Kubernetes defaults `imagePullPolicy: Always` for `:latest`,
so even after `kind load` the pod tries to **pull from a registry** and fails.
Diagnose → fix:

```bash
kubectl describe pod <pod> -n tropis      # read Events — the first debug move
kubectl patch deployment frontend -n tropis --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]'
kubectl rollout status deployment/frontend -n tropis
```

`kind load` puts the image on the node; `pullPolicy: Always` ignores it;
`IfNotPresent` uses the local copy. Deploy the full stack the same way with
`kubectl apply -k infra/k8s` (backend pods `CrashLoopBackOff` until their
datastores exist — `kubectl logs <pod>` shows why). Install Argo CD into the
kind cluster and apply `infra/argocd/project.yaml` + `infra/argocd/app-dev.yaml`
to rehearse GitOps locally. Cleanup: `kind delete cluster --name tropis`.

**See the cluster visually** instead of `kubectl get pods` loops: `make k8s`
opens **k9s** (terminal UI — pods/logs/events/exec, real-time) and `make k8s-ui`
opens **Headlamp** (browser/desktop UI). Both auto-install via brew and target
the `kind-tropis` context / `tropis` namespace.

### Rung 3 — Production tiers (pick by traction; you do NOT need full GitOps day one)

| Tier                                        | What                                                 | Complexity             | Rough $/mo                                | Right when                    |
| ------------------------------------------- | ---------------------------------------------------- | ---------------------- | ----------------------------------------- | ----------------------------- |
| **3a. One server + Compose**                | A VM running the Compose stack + domain + HTTPS      | Low                    | ~$40–80                                   | Solo, validating a product    |
| **3b. Managed k8s + `kubectl`**             | GKE/EKS, apply manifests by hand                     | Medium                 | ~$250–600                                 | Want k8s, not full automation |
| **3c. Full GitOps** (this runbook's target) | k8s + Argo CD + Vault + ESO + Envoy + all datastores | High (real SRE effort) | ~$250–600 self-hosted; $2k–5k+ managed-HA | Real users, a team, scale     |

The same code runs on all three — **no rewrite** to graduate. The bigger cost of
3c is not the bill, it's the setup weeks + ongoing operation (certs, backups,
alerting, on-call). The rest of this document is the 3c runbook.

## Building & pushing images

Done by CI. Pushing a semver tag triggers `.github/workflows/deploy-prod.yml`:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

The workflow logs in to GHCR with `GITHUB_TOKEN`, builds `apps/backend/Dockerfile` and the frontend image, tags them with the version, and applies the K8s manifests. **Image tags should map 1:1 to a git ref (semver tag / git SHA)** — never deploy `:latest`; rollback depends on immutable tags.

Manual build if needed:

```bash
docker build -f apps/backend/Dockerfile -t ghcr.io/<org>/<repo>/backend:v1.2.3 .
docker push ghcr.io/<org>/<repo>/backend:v1.2.3
```

## Deploying to Kubernetes

Manifests live in `infra/k8s/base/` (namespace, networkpolicy, backend deployment+service+configmap+secret+PDB, frontend deployment+service+PDB) with a kustomize overlay for prod at `infra/k8s/overlays/prod/` (HPA + ingress):

```bash
# dev/base
kubectl apply -k infra/k8s
# production
kubectl apply -k infra/k8s/overlays/prod
kubectl -n <namespace> rollout status deploy/backend
```

### Staging

Recommended promotion flow: **dev (base) → staging → prod**. The staging
overlay lives at `infra/k8s/overlays/staging/` — same shape as prod but in
namespace `tropis-staging`, 1 replica per service, HPA capped at 2, halved
resource requests, and ingress on `staging.yourdomain.com`:

```bash
kubectl apply -k infra/k8s/overlays/staging
```

For GitOps, a commented optional Argo CD Application (`tropis-staging`) is
provided in `infra/argocd/tropis-staging.yaml` — uncomment it (and add the
`tropis-staging` namespace to `project.yaml` destinations) to have Argo track
the staging overlay alongside prod.

## GitOps with Argo CD (recommended)

Instead of CI running `kubectl apply`, let Argo CD watch the repo and sync the
cluster to git — manifests in `infra/argocd/` (see its README for install +
UI access):

- `project.yaml` — AppProject scoped to the `tropis` namespace and this repo.
- `app-prod.yaml` — Application tracking `infra/k8s/overlays/prod` with
  automated sync (`prune: true`, `selfHeal: true`), `CreateNamespace=true`
  and a 10-revision history for one-click rollback.
- `app-dev.yaml` — optional, tracks the base for a dev cluster.

Flow: CI (`deploy-prod.yml`) builds/pushes images and pins the new tag with
`kustomize edit set image` in `infra/k8s/overlays/prod/kustomization.yaml`.
For **true GitOps the workflow should commit that kustomization change back to
the repo instead of running `kubectl apply`** — Argo detects the commit and
rolls it out. A commented-out "Commit image tag bump" step is included in
`deploy-prod.yml`; enable it (and drop the kubectl steps, plus grant
`contents: write`) to switch. The existing kubectl path remains as fallback.

What you get in the Argo UI: per-service health cards, live-vs-git diff,
current image tag, and one-click rollback to any synced revision.

## Secrets

⚠️ **`infra/k8s/base/backend/secret.yaml` contains placeholder values and is DEV-ONLY.** Never put real credentials in it — it's committed to git.

Production = **External Secrets Operator (ESO) + Vault**:

1. Install ESO: `helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace`
2. Enable the KV engine and write secrets into Vault: `vault kv put secret/backend JWT_SECRET=... MONGODB_URI=...`
3. Create a Vault policy (see `infra/vault/policy.hcl`) and a Kubernetes auth role for ESO.
4. Enable the ready-made `SecretStore` + `ExternalSecret` manifest at `infra/k8s/base/backend/external-secret.yaml` (see its header comment) — it materializes the `backend-secrets` Secret the deployment already references.
5. Swap `backend/secret.yaml` for `backend/external-secret.yaml` in `infra/k8s/base/kustomization.yaml` (the swap is documented inline there).

Rotation then happens in Vault; ESO refreshes the K8s Secret automatically.

## TLS / cert-manager / ingress

- Ingress in `infra/k8s/overlays/prod/ingress.yaml`.
- Install cert-manager, create a `ClusterIssuer` (Let's Encrypt HTTP-01), annotate the ingress `cert-manager.io/cluster-issuer: letsencrypt-prod` and set `spec.tls`. Certificates auto-renew.
- Remember gRPC needs HTTP/2 — annotate nginx with `nginx.ingress.kubernetes.io/backend-protocol: "GRPC"` for the gRPC service path, or terminate gRPC-Web at Envoy.

## Autoscaling

`infra/k8s/overlays/prod/hpa.yaml` scales the backend on CPU. Ensure resource `requests` are set on the deployment (HPA math depends on them). Tune min/max replicas per environment load tests.

## Rollback — three layers

### 1. Application

```bash
kubectl -n <ns> rollout undo deploy/backend            # previous ReplicaSet
kubectl -n <ns> rollout undo deploy/backend --to-revision=3
# or explicitly pin the previous image tag:
kubectl -n <ns> set image deploy/backend backend=ghcr.io/<org>/<repo>/backend:v1.2.2
```

App rollback is only safe because of layer 2:

### 2. Database — forward-compatible migrations only

Migrations (`apps/backend/migrations/`, node-pg-migrate; `pnpm --filter @tropis/backend migrate:up|down`) must obey:

- **Additive only** in one release: add columns/tables/indexes; never drop or rename in the same release that stops using them.
- **Two-phase renames**: release N adds the new column + dual-writes; release N+1 backfills and switches reads; release N+2 drops the old column.
- **Every migration has a working `down`.**
- **Invariant: the previous app version must run correctly on the new schema.** That's what makes `rollout undo` a one-liner instead of an incident.

### 3. Events

- Payloads are **add-only** (see `docs/api-versioning.md`); consumers tolerate unknown fields.
- Therefore a rolled-back producer emitting the old shape is always consumable, and old events in Pulsar backlog / the Mongo event store are always replayable. Never "fix" history — emit compensating events.

## Post-deploy verification

```bash
kubectl -n <ns> get pods
curl -sf https://<host>/api/health | jq .
# Grafana dashboards + Jaeger traces for error rate/latency deltas
```

## Backups & disaster recovery

**What is backed up** (the three stores that hold data you cannot recreate):

| Store                                       | Contents                                               | Tool                                                     |
| ------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| MongoDB (`tropis_mongodb`)                  | Users, outbox, event store — the system of record      | `mongodump --archive --gzip`                             |
| PostgreSQL (`tropis_postgres`)              | Relational data + pgvector embeddings, migration state | `pg_dump -Fc`                                            |
| ClickHouse (`tropis_clickhouse`, db `logs`) | Analytics/tracking/audit history                       | per-table `SELECT … FORMAT Native` + `SHOW CREATE TABLE` |

**What is NOT backed up (deliberately — rebuildable/derived):**

- **Redis** — cache and rate-limit/lockout counters; cold start just repopulates.
- **Pulsar** — transient event transport; the Mongo outbox/event store is the source of truth and events are replayable (see Rollback → Events above).
- **Elasticsearch** — search indexes are re-derivable from MongoDB.
- **Aerospike** — sessions with 7-day TTL; loss = users re-login.
- **MinIO** — object storage; if uploads matter in your deployment, mirror the bucket separately (`mc mirror local/app-uploads backup/app-uploads`).
- **Temporal's Postgres** — workflow history; treat as re-runnable in dev. In prod, back it up like any Postgres if in-flight workflows are business-critical.

**Local usage:**

```bash
make backup                    # → ./backups/<UTC timestamp>/
make restore TS=20260812-030000   # destructive, asks for confirmation
# Optional S3/MinIO offsite copy:
mc alias set backup https://s3.example.com ACCESS_KEY SECRET_KEY
MC_ALIAS=backup MC_BUCKET=backups ./infra/backup/backup.sh
```

Scripts live in `infra/backup/` (`set -euo pipefail`, refuse to run if the
containers aren't up).

**Kubernetes:** `infra/k8s/base/backup/cronjob.yaml` holds template CronJobs
(mongodump + pg_dump, `0 3 * * *`, 14-day retention to a PVC, optional `mc`
S3 upload). It is intentionally **not** in `kustomization.yaml` — configure
storage first, then uncomment the resource line (same pattern as the ESO
external-secret).

**Restore drill — practice quarterly.** A backup you have never restored is a
hope, not a backup:

1. Spin up a scratch environment (`make up` on a clean Docker, or a dev cluster).
2. `make restore TS=<latest>` and run the app against it.
3. Verify: `curl /api/health` is green, admin login works, user count matches,
   a ClickHouse tracking query returns data.
4. Time the drill — that number is your realistic RTO. Record it.

## Secrets rotation

### JWT secret (dual-key procedure)

The code today verifies with a single `JWT_SECRET` (`auth.module.ts`,
`jwt.strategy.ts`), so a naive swap instantly invalidates every access and
refresh token. Rotation **procedure**:

1. **Preferred (dual-key window):** deploy a change that verifies with
   _old + new_ secrets (sign with new only) — e.g. `secretOrKeyProvider`
   trying both. Run the window for at least the access-token TTL, then remove
   the old key. This is a small code change the current single-key setup does
   not yet support — treat this paragraph as the runbook for when it lands.
2. **Today (hard cut):** rotate during low traffic. Update `JWT_SECRET` in
   Vault (`vault kv put secret/backend JWT_SECRET=...`); ESO refreshes the K8s
   Secret; restart pods. **All sessions are invalidated** — access tokens fail
   verification and refresh tokens force re-login. Announce it; expect a
   login spike.

### API keys (`API_KEYS`)

`API_KEYS` is a JSON map `{ "<keyId>": "<secret>" }` (see
`common/guards/api-key.service.ts`), so rotation is zero-downtime by design:

1. Add a **new keyId** with a new secret alongside the old one (in Vault; the
   app reads it via the env merge — no code change).
2. Migrate callers to the new keyId (they send it in `x-api-key`).
3. Remove the old keyId once its traffic hits zero (watch logs/metrics).

### Vault itself

- **AppRole secret-ids**: set `secret_id_ttl` and rotate via
  `vault write -f auth/approle/role/<role>/secret-id`; distribute the new
  secret-id, revoke old accessors (`.../secret-id-accessor/destroy`).
- **Root token**: revoke it after initial setup (`vault token revoke <root>`);
  regenerate only via `vault operator generate-root` with unseal-key quorum.
- **Unseal keys**: rekey periodically or after operator departure with
  `vault operator rekey`.

## Production MongoDB

The compose file runs a **single-node replica set** (`--replSet rs0`, one
member). That exists only so change streams and transactions work in dev — it
provides **zero redundancy** and is not production-safe. In production use:

- a real **3-node replica set** (spread across zones, `majority` write
  concern), self-managed or via the MongoDB Kubernetes operator, **or**
- **MongoDB Atlas** (managed): backups, point-in-time restore, and failover
  included — usually the right default unless data-residency rules say
  otherwise.

## Component map (what each piece is)

One line each, grouped by job. "Skip early" flags what you don't need before
traction — see [tech-decisions.md](tech-decisions.md) for the full "use X only
when…" tables.

**Orchestration & delivery**

- **Kubernetes (k8s)** — runs and heals your containers across machines.
- **Kustomize** — layers per-environment patches (`base` + `overlays`), no templating.
- **Argo CD** — GitOps: continuously syncs the cluster to Git; auto-rollback on drift.
- **Envoy** — edge proxy; transcodes browser gRPC-Web → gRPC for the backend.

**Secrets & policy**

- **Vault** — central secret store; issues/rotates credentials.
- **External Secrets Operator (ESO)** — projects Vault secrets into native k8s Secrets.
- **OPA** — policy-as-code authorization (`infra/opa/authz.rego`), unit-tested with `opa test`.

**Data stores**

- **MongoDB** — primary application database + the event outbox (system of record).
- **PostgreSQL** — relational store; a second instance backs Temporal.
- **Redis** — cache, rate-limit/lockout state, nonce dedup, WebSocket fan-out.
- **Aerospike** — optional ultra-high-QPS cache tier (skip early).
- **ClickHouse** — columnar analytics store (dashboards, `user_behavior`, audit log).
- **MinIO** — S3-compatible object storage (uploads, backups).

**Event & workflow pipeline**

- **Pulsar** — message broker; carries outbox events to consumers.
- **Flink** — stream processing; aggregates events into ClickHouse.
- **Temporal** — durable workflows (retries/compensation for multi-step processes).

**Observability**

- **Prometheus** — metrics + alerting rules. **Grafana** — dashboards.
- **OpenTelemetry (OTel)** — traces/metrics collection across services.

## kubectl cheat sheet (the daily 8)

```bash
kubectl config current-context             # which cluster am I talking to?!
kubectl get pods -n <ns>                   # what's running / crashing
kubectl describe pod <pod> -n <ns>         # WHY — read the Events section first
kubectl logs <pod> -n <ns>                 # container logs (-f to follow)
kubectl get all -n <ns>                    # everything in a namespace
kubectl rollout status deploy/<d> -n <ns>  # is the update done?
kubectl rollout undo deploy/<d> -n <ns>    # roll back to previous ReplicaSet
kubectl port-forward svc/<svc> -n <ns> 8088:80   # reach it locally
```

`describe` (events) and `logs` explain ~90% of failures. Always check the
context before anything destructive.
