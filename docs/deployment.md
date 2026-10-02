# Deployment

How the foundation runs beyond a laptop: the container images, local
Kubernetes with `kind`, production Kubernetes (kustomize overlays, ingress,
network policy, autoscaling), GitOps with Argo CD, secrets in production
(Vault), rollback, backups, scaling, and native distribution (PWA, Android,
iOS, desktop).

Local Docker Compose, day-to-day commands and the full env var reference live in
[development.md](development.md). Branching, releases and CI live in
[CONTRIBUTING.md](../CONTRIBUTING.md). The pre-launch security review is
[security-checklist.md](security-checklist.md).

## Environments

Climb one rung at a time. Everything below production is free and local, and is
the safe place to break things.

| Rung                | Tool                                                            | Proves                                             |
| ------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| 1. Docker Compose   | `make up` + `make dev` ([development.md](development.md))       | The whole pipeline runs end to end                 |
| 2. Local Kubernetes | `kind` + `kubectl` ([Local Kubernetes](#local-kubernetes-kind)) | The manifests deploy and operate the way prod does |
| 3. Staging          | `infra/k8s/overlays/staging`                                    | A release behaves on a real cluster                |
| 4. Production       | `infra/k8s/overlays/prod` + Argo CD or `deploy-prod.yml`        | Real users, scale, failure survival                |

Production does not have to start with full GitOps. The same code runs on each
of these, so moving up needs no rewrite:

| Tier                         | What                                                                                                                                                    | Right when                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| One server + Compose         | A VM running the Compose datastores and the backend role images, a domain and HTTPS, with [Production configuration](#production-configuration) applied | Solo, validating a product           |
| Managed Kubernetes + kubectl | GKE/EKS/AKS, overlays applied by CI or by hand                                                                                                          | Want Kubernetes, not full automation |
| Full GitOps                  | Kubernetes + Argo CD + Vault + ESO + managed datastores                                                                                                 | Real users, a team, scale            |

The larger cost of full GitOps is operation, not the bill: certificates,
backups, alerting and on-call.

## Prerequisites

- Docker, `kubectl` (kustomize is built in: `kubectl apply -k`), access to the target cluster
- Node 22 and pnpm 10 (`corepack enable`; the root `packageManager` field pins the version CI and every image use)
- Local Kubernetes: `kind` (`brew install kind kubernetes-cli`)
- Production cluster add-ons: an ingress controller (the manifests assume ingress-nginx; see [Ingress and TLS](#ingress-and-tls) for the controller choice), cert-manager, External Secrets Operator, and a Vault reachable from the cluster

## Images

Every image builds from the **repo root** as context, because each Dockerfile
needs the pnpm workspace or the shared `proto/` directory.

| Image             | Dockerfile                                     | Runtime                                                | Port(s)           | User                                 | Built by `deploy-prod.yml` |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------ | ----------------- | ------------------------------------ | -------------------------- |
| backend-public    | `apps/backend/Dockerfile` `--target public`    | `node:22-bookworm-slim`, `node dist/public/main.js`    | 3100, 50051, 9464 | uid 1001 (`appuser`)                 | yes                        |
| backend-private   | `apps/backend/Dockerfile` `--target private`   | `node:22-bookworm-slim`, `node dist/private/main.js`   | 50061, 9464       | uid 1001 (`appuser`)                 | yes                        |
| backend-worker    | `apps/backend/Dockerfile` `--target worker`    | `node:22-bookworm-slim`, `node dist/worker/main.js`    | 9464              | uid 1001 (`appuser`)                 | yes                        |
| backend-scheduler | `apps/backend/Dockerfile` `--target scheduler` | `node:22-bookworm-slim`, `node dist/scheduler/main.js` | 9464              | uid 1001 (`appuser`)                 | yes                        |
| frontend          | `apps/frontend/helm/Dockerfile`                | `nginx:alpine` serving helm (the console)              | 8080              | uid 101 (`nginx`), set by Kubernetes | yes                        |
| harbor            | `apps/frontend/harbor/Dockerfile`              | `node:22-alpine`, Next.js standalone server            | 4000              | uid 1001 (`nextjs`)                  | yes                        |
| signing           | `services/rust/signing/Dockerfile`             | `debian:bookworm-slim`, Rust gRPC binary               | 50052             | uid 10001 (`signing`)                | no                         |

```bash
for r in public private worker scheduler; do
  docker build -f apps/backend/Dockerfile --target $r -t tropis/backend-$r:local .
done
docker build -f apps/frontend/helm/Dockerfile    -t tropis/frontend:local .
docker build -f apps/frontend/harbor/Dockerfile  -t tropis/harbor:local .
docker build -f services/rust/signing/Dockerfile      -t tropis/signing:local .
```

### Backend

One Dockerfile, one image per role ([architecture.md](architecture.md#backend-roles)).
`builder` installs the workspace deps for `@tropis/backend...`, builds
`@tropis/shared`, then the backend: `nest build` (tsc, which emits the
decorator metadata Nest DI needs) and `esbuild.config.mjs`, which bundles each
role's entry into `dist/<role>/main.js` with only the code that role's root
module reaches (packages stay external). `deps` installs the production
dependencies, and `runtime` is a fresh `node:22-bookworm-slim` holding only
that tree, the `@tropis/shared` build and `libyaml` (the aerospike addon links
it), with no package manager; each role target (`public`, `private`, `worker`,
`scheduler`) adds its own bundle to it. The default target is `public`. The
runtime is Debian (glibc), not Alpine, because `@temporalio/core-bridge` ships
glibc binaries only and the worker would crash at boot on musl. The user is
pinned to the numeric uid 1001 so Kubernetes `runAsNonRoot` can verify it.
Every Node image gets pnpm through corepack from the root `packageManager`
field, so image builds and CI run the same pnpm. The helm image builds
`@tropis/shared` before helm, because `tsc -b` resolves its types from the
build output, which `.dockerignore` keeps out of the context.

The signing image builds on `rust:<version>-slim-bookworm` and runs on
`debian:bookworm-slim`: builder and runtime share one glibc, so the binary
never needs a newer glibc than the runtime has.

Ports: 3100 HTTP and WebSocket and 50051 the public RPC tier (public); 50061
the internal RPC tier (private); 9464 the ops port on every role (`/livez`,
`/readyz`, `/metrics`), which no Service or ingress routes.

```bash
docker run -p 3100:3100 -p 50051:50051 -p 9464:9464 --env-file apps/backend/.env tropis/backend-public:local
```

`apps/backend/.env` points at `localhost`, which inside the container is the
container itself. Override the datastore hosts (for example with
`host.docker.internal` on Docker Desktop) when running the image against the
Compose datastores.

### Frontends: endpoints are baked in at build time

helm (the console) is a static SPA; its image and Deployment are named
`frontend`. Its five `VITE_*` values (`apps/frontend/helm/src/lib/env.ts`) are
inlined by `vite build`, so they are fixed per image:

| Variable            | Value                                                                                       | Default if unset         | Dockerfile `ARG` | Passed by `deploy-prod.yml` |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------ | ---------------- | --------------------------- |
| `VITE_API_BASE_URL` | Bare API origin, **without** `/api` (the SDK appends it), e.g. `https://api.yourdomain.com` | `http://localhost:3100`  | yes              | yes (`PROD_API_BASE_URL`)   |
| `VITE_WS_URL`       | Socket.io origin, e.g. `https://api.yourdomain.com`                                         | `http://localhost:3100`  | yes              | yes (`PROD_WS_URL`)         |
| `VITE_RPC_URL`      | Backend public RPC origin (Connect protocol), e.g. `https://rpc.yourdomain.com`             | `http://localhost:50051` | yes              | yes (`PROD_RPC_URL`)        |
| `VITE_SITE_URL`     | The console's own origin, used for absolute SEO URLs                                        | `http://localhost:5173`  | yes              | yes (`PROD_CONSOLE_URL`)    |
| `VITE_TENANT_ID`    | The tenant the console signs in to, sent as `X-Tenant-ID`                                   | `dev`                    | yes              | yes (`PROD_TENANT_ID`)      |

A plain `docker build` of helm passes no build args, so every value falls back
to its default. The deployed image gets all five from `deploy-prod.yml`, which
reads them from GitHub repository variables (Settings → Variables → Actions).
An unset `PROD_TENANT_ID` builds a console that signs in to `dev`, which a
production tenant directory does not hold, so every sign-in fails.

The image also renders its Content-Security-Policy from the same build args:
`scripts/render-nginx-conf.mjs` fills the `connect-src` of `nginx.conf` with
`VITE_API_BASE_URL`, `VITE_RPC_URL` and `VITE_WS_URL` (plus its `ws:`/`wss:`
form), so the policy names exactly the endpoints the bundle calls, and it fails
the build when the hash of the inline theme script in `dist/index.html` is
missing from the policy.

The helm Dockerfile sets no `USER`, so the image starts as root; Kubernetes
runs it as the `nginx` user through `runAsUser: 101` in
`infra/k8s/base/frontend/deployment.yaml`.

harbor reads `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_CONSOLE_URL`
(`apps/frontend/harbor/lib/site.ts`, defaults `http://localhost:4000` and
`http://localhost:8088`). `NEXT_PUBLIC_*` values are inlined by `next build`.
The harbor Dockerfile declares both as `ARG`s; `deploy-prod.yml` passes them
from the repository variables `PROD_SITE_URL` and `PROD_CONSOLE_URL`, and a
plain `docker build` bakes the localhost defaults into its prerendered pages.

### Tags and registry

`deploy-prod.yml` pushes to GHCR as `ghcr.io/<owner>/<repo>/{backend-<role>,frontend,harbor}`,
tagged with the git tag (`v1.2.3`) and `latest`. It lowercases `<owner>/<repo>`
first, because registry paths must be lowercase and `github.repository` keeps
the original case. The manifests use the
placeholder names `ghcr.io/tropis/{backend-public,backend-private,backend-worker,backend-scheduler,frontend,harbor}`; the overlay
`images:` block maps them to the real registry path, so `infra/k8s/base` does
not need editing.

In git, both overlays keep `newTag: latest`. `deploy-prod.yml` pins the version
tag with `kustomize edit set image` on the runner only and does not commit the
change, so what runs in the cluster is the version tag while git still says
`latest`. Deploy immutable version tags only: a rollback to a previous
ReplicaSet or tag works only while that tag still exists in the registry, so
never delete or overwrite released tags. This split is also why CI deploys and
Argo CD self-heal conflict ([GitOps with Argo CD](#gitops-with-argo-cd)); pick
one deploy path.

Manual build and push:

```bash
for r in public private worker scheduler; do
  docker build -f apps/backend/Dockerfile --target $r -t ghcr.io/<owner>/<repo>/backend-$r:v1.2.3 .
  docker push ghcr.io/<owner>/<repo>/backend-$r:v1.2.3
done
```

The signing service runs only under the Compose `signing` profile; no
Kubernetes manifest or deploy job ships it. CI builds and scans its image with
the others.

GHCR packages of a private repository are private, so the cluster needs a pull
secret. The manifests name none; attach one to the namespace's `default`
ServiceAccount, which every pod uses:

```bash
kubectl -n tropis create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=<user> --docker-password=<PAT with read:packages>
kubectl -n tropis patch serviceaccount default -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'
```

Pods set `automountServiceAccountToken: false`, which does not affect pull
secrets.

## Local Kubernetes (kind)

`kind` runs a real cluster inside Docker: the same manifests, the same
`kubectl`, the same failure modes. The backend pod talks to the Compose
datastores on the host through `infra/k8s/local-kind/host-datastores.yaml`,
which mirrors production (a stateless app in the cluster, datastores outside
it). That file is for local `kind` only.

```bash
kind create cluster --name tropis
kubectl get nodes                                  # wait for Ready
make up                                            # host datastores (Mongo replica set initiated)

# kind has its own image store: build on the host, then load explicitly
ROLES="public private worker scheduler"
for r in $ROLES; do docker build -f apps/backend/Dockerfile --target $r -t tropis/backend-$r:local .; done
docker build -f apps/frontend/helm/Dockerfile   -t tropis/frontend:local .
docker build -f apps/frontend/harbor/Dockerfile -t tropis/harbor:local .
docker build -f infra/opa/Dockerfile            -t tropis/opa:local .
kind load docker-image $(for r in $ROLES; do echo tropis/backend-$r:local; done) tropis/frontend:local tropis/harbor:local tropis/opa:local --name tropis

kubectl apply -k infra/k8s                         # base: backend, helm, harbor, policies
kubectl apply -f infra/k8s/local-kind/host-datastores.yaml
for r in $ROLES; do kubectl -n tropis set image deployment/backend-$r backend=tropis/backend-$r:local; done
kubectl -n tropis set image deployment/frontend frontend=tropis/frontend:local
kubectl -n tropis set image deployment/harbor   harbor=tropis/harbor:local
kubectl -n tropis set image deployment/opa      opa=tropis/opa:local
```

**`ImagePullBackOff` is expected at this point.** The base images are tagged
`:latest`, so Kubernetes defaulted `imagePullPolicy: Always` when the
Deployments were created, and `set image` does not change it. The pod ignores
the loaded image and tries a registry. Switch to `IfNotPresent`:

```bash
kubectl -n tropis describe pod <pod>               # read Events first
for d in backend-public backend-private backend-worker backend-scheduler frontend harbor opa; do
  kubectl -n tropis patch deployment $d --type=json \
    -p='[{"op":"replace","path":"/spec/template/spec/containers/0/imagePullPolicy","value":"IfNotPresent"}]'
done
kubectl -n tropis rollout status deployment/backend-public
```

Reach the apps (the helm image was built with the localhost defaults, so
forward the backend's HTTP and RPC ports too):

```bash
kubectl -n tropis port-forward svc/frontend-svc 8088:80     # helm   → http://localhost:8088
kubectl -n tropis port-forward svc/harbor-svc   8089:80     # harbor → http://localhost:8089
kubectl -n tropis port-forward svc/backend-svc  3100:3100   # REST + WebSocket
kubectl -n tropis port-forward svc/backend-svc  50051:50051 # RPC (Connect)
```

`host-datastores.yaml` sets `CORS_ORIGIN=http://localhost:8088`, the forwarded
helm origin. The backend applies that one allow-list to REST, Socket.io and the
public RPC listener, so the forwarded console's calls pass CORS.

A pod turns Ready once boot has finished (`/readyz` answers 503
`{"status":"starting"}` until then) and every probe its role requires passes
([Probes](#manifest-layout)); the worker also requires its event consumers to
be subscribed (the `consumers` probe). Any other capability that is down is
only listed in `degraded`. `host-datastores.yaml` points SMTP at the Compose Mailpit
(`host.docker.internal:1025`), sets `KEYSPACE_ENV=kind` and selects every adapter explicitly (vector,
search and objects on, graph off), so the local cluster exercises the same
capabilities as `make up`.

Re-running `kubectl apply -k infra/k8s` restores the base `backend-config` and
`backend-secret`; re-apply `host-datastores.yaml` and
`kubectl -n tropis rollout restart deployment -l component=backend` afterwards.

To rehearse GitOps locally, install Argo CD into the kind cluster
([GitOps with Argo CD](#gitops-with-argo-cd)), replace the placeholder repo URL
and apply `infra/argocd/project.yaml` and `infra/argocd/app-dev.yaml`.

Cluster views: `make k8s` opens k9s on the `kind-tropis` context and the
`tropis` namespace. `make k8s-ui` opens the Headlamp app (macOS only, it uses
`open -a`), where you pick the `kind-tropis` context yourself. Both install via
Homebrew on first use and exit if the `kind-tropis` context does not exist.

Cleanup: `kind delete cluster --name tropis`.

## Production Kubernetes

### Manifest layout

| Path                                          | Contents                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/k8s/kustomization.yaml`                | Thin wrapper: `kubectl apply -k infra/k8s` builds the base                                                                                                                                                                                                             |
| `infra/k8s/base/`                             | `tropis` Namespace, NetworkPolicies, backend (one Deployment per role, `backend-svc` over public, `backend-internal-svc` over private, ConfigMap, placeholder Secret, PDBs), frontend = helm (Deployment, `frontend-svc`, PDB), harbor (Deployment, `harbor-svc`, PDB) |
| `infra/k8s/base/backend/external-secret.yaml` | ESO `SecretStore` + `ExternalSecret`, not in the kustomization by default ([Secrets in production](#secrets-in-production))                                                                                                                                            |
| `infra/k8s/base/backup/cronjob.yaml`          | Backup CronJob template, not in the kustomization by default ([Backups](#backups-and-disaster-recovery))                                                                                                                                                               |
| `infra/k8s/overlays/prod/`                    | HPAs, Ingress, image pins, ConfigMap overrides, replica counts                                                                                                                                                                                                         |
| `infra/k8s/overlays/staging/`                 | Same shape as prod, scaled down, namespace `tropis-staging`                                                                                                                                                                                                            |
| `infra/k8s/local-kind/`                       | Host-datastore ConfigMap/Secret for local `kind` only                                                                                                                                                                                                                  |

The repo ships no datastore manifests. MongoDB, PostgreSQL, Redis, ClickHouse,
Pulsar, Elasticsearch, object storage (a managed S3 service), Temporal and
Aerospike run as managed services or are installed separately, and the backend reaches them through its
ConfigMap and Secret.

OPA is not a datastore: it is stateless and decides every authorization, so it
ships with the release. `infra/opa/Dockerfile` bakes the policies
(`authz.rego`, `system_authz.rego`) into `ghcr.io/tropis/opa`, built and
Trivy-scanned in CI and pinned per release like the backend images; the base
runs it as the `opa` Deployment behind `opa-svc:8181` (two replicas, a PDB,
non-root, read-only root filesystem), with `OPA_TOKEN` from `backend-secret`
and token authentication on. Only backend pods reach it (`allow-opa-from-backend`),
and it opens no outbound connection. Shipping the policies in the image means a
release always runs the policies its CI tested.

Every Deployment runs as non-root with a read-only root filesystem, drops all
capabilities, uses the `RuntimeDefault` seccomp profile, mounts no
ServiceAccount token (no pod calls the Kubernetes API) and keeps
`revisionHistoryLimit: 10`. Every multi-replica Deployment spreads its pods
across zones and nodes (`topologySpreadConstraints`, `ScheduleAnyway`, so a
small cluster still schedules). Base replicas: backend-public 2,
backend-private 2, backend-worker 2, backend-scheduler 1 (strategy `Recreate`),
frontend 2, harbor 2. Backend pods carry `prometheus.io/scrape|port|path`
annotations for the ops port (`9464`, `/metrics`); no Service routes that
port, so Prometheus scrapes the pods directly. Readiness fails only on a
dependency the role requires (`READINESS_PROBES` in
`apps/backend/src/modules/health/health.probes.ts`); liveness checks only the
process, so a dependency outage never restarts a pod. The ops port opens only
once boot has finished, and boot waits on connection retries (MongoDB,
PostgreSQL) that can take minutes, so every backend role has a startup probe
on `/livez` (every 5 s, up to 180 s) that holds liveness and readiness off
until the process is up; a fixed initial delay would have the liveness probe
kill a slow boot.

Termination: backend-public and backend-private sleep 5 s in `preStop`, so the
endpoint removal reaches every proxy before SIGTERM, then stop accepting and
drain in-flight calls for at most 10 s (`DRAIN_TIMEOUT_MS`), within a 30 s
grace. backend-worker has no Service and no `preStop`; its 60 s grace covers
an in-flight outbox publish (at most 30 s) plus the consumer and job drains.
backend-scheduler has 30 s. Each role also ends itself at a hard shutdown
deadline inside its grace (`SHUTDOWN_TIMEOUT_MS`, default 55 s on the worker
and 20 s elsewhere), so a close that never settles exits with an error code
instead of being killed. frontend and harbor sleep 5 s in `preStop` for the
same endpoint-removal reason.

| Workload          | Probes                                                           | Requests / limits          |
| ----------------- | ---------------------------------------------------------------- | -------------------------- |
| backend-public    | startup + liveness `GET /livez`, readiness `GET /readyz` on 9464 | 100m / 256Mi, 500m / 512Mi |
| backend-private   | same                                                             | 50m / 128Mi, 500m / 512Mi  |
| backend-worker    | same                                                             | 100m / 256Mi, 1 / 1Gi      |
| backend-scheduler | same                                                             | 25m / 96Mi, 200m / 256Mi   |
| frontend          | readiness + liveness `GET /` on 8080                             | 50m / 64Mi, 200m / 128Mi   |
| harbor            | startup (up to 120 s), readiness + liveness `GET /` on 4000      | 100m / 128Mi, 500m / 256Mi |

### Overlays

| Setting           | prod (`overlays/prod`)                                                          | staging (`overlays/staging`)                                                   |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Namespace         | `tropis` (from the base)                                                        | `tropis-staging` (namespace transformer)                                       |
| Replicas          | private 2, scheduler 1, harbor 2; public, worker and frontend: HPA              | private 1, scheduler 1, harbor 2 (base); public, worker and frontend: HPA      |
| HPA               | backend public 3–10, worker 3–10, frontend 2–6                                  | backend public 1–2, worker 1–2, frontend 1–2                                   |
| Requests          | base                                                                            | backend public and worker 50m/128Mi, frontend 25m/32Mi                         |
| `LOG_LEVEL`       | `warn`                                                                          | `info`                                                                         |
| `KEYSPACE_ENV`    | `production`                                                                    | `staging`                                                                      |
| `SERVICE_VERSION` | the release tag (set by `deploy-prod.yml`)                                      | unset                                                                          |
| `CORS_ORIGIN`     | `https://app.yourdomain.com`                                                    | `https://staging.yourdomain.com`                                               |
| Image pins        | the four backend images, frontend, harbor                                       | the four backend images, frontend (harbor stays on `:latest`)                  |
| Ingress hosts     | apex + www (harbor), `app.` (helm), `api.` (backend HTTP), `rpc.` (backend RPC) | `staging.` (helm), `api.staging.` (backend HTTP), `rpc.staging.` (backend RPC) |

Both set `NODE_ENV=production`. `KEYSPACE_ENV` differs per environment (the
base sets `dev`) because it prefixes every cache, kv, lock, ratelimit and dedup
key; two environments that share a Redis would otherwise read each other's
keys. The base `CORS_ORIGIN` is the console origin `https://app.yourdomain.com`.

A Deployment an HPA scales carries no `replicas` in the overlays (a JSON patch
removes the base value), so `kubectl apply` never resets the HPA's choice. The
first apply that drops the field scales such a Deployment to 1 until the HPA
acts again; Argo CD ignores `/spec/replicas` on them
([GitOps with Argo CD](#gitops-with-argo-cd)).

Promotion runs dev (base) → staging → prod:

```bash
kubectl kustomize infra/k8s/overlays/prod          # render and review first
kubectl apply -k infra/k8s/overlays/staging
kubectl apply -k infra/k8s/overlays/prod
kubectl -n tropis rollout status deploy/backend-public
```

`deploy-prod.yml` pins images only in the prod overlay. Staging pins are set by
hand with `kustomize edit set image` in `infra/k8s/overlays/staging`.

### Placeholders to replace before the first deploy

| File                                         | Replace                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `infra/k8s/overlays/prod/ingress.yaml`       | `yourdomain.com`, `www.`, `app.`, `api.`, `rpc.` hosts (each appears in `tls.hosts` and `rules`); `ingressClassName: nginx` if using another controller      |
| `infra/k8s/overlays/prod/kustomization.yaml` | `CORS_ORIGIN=https://app.yourdomain.com`                                                                                                                     |
| `infra/k8s/overlays/staging/*.yaml`          | `staging.yourdomain.com`, `api.staging.yourdomain.com`, `rpc.staging.yourdomain.com`, `CORS_ORIGIN`, OAuth callback URLs                                     |
| `infra/k8s/base/backend/configmap.yaml`      | Datastore endpoints, `CORS_ORIGIN`, `OAUTH_TENANT_ID`, `GOOGLE_CALLBACK_URL` / `GITHUB_CALLBACK_URL` ([Production configuration](#production-configuration)) |
| `infra/k8s/base/kustomization.yaml`          | Swap `backend/secret.yaml` for `backend/external-secret.yaml`                                                                                                |
| `infra/argocd/*.yaml`                        | Repo URL `https://github.com/tropis/tropis.git`                                                                                                              |

GitHub Actions secrets (Settings → Secrets → Actions) used by `deploy-prod.yml`:

| Secret        | Value                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| `KUBE_CONFIG` | Cluster kubeconfig, base64-encoded: `kubectl config view --raw \| base64` |

The frontend build URLs are public, so `deploy-prod.yml` reads them from
repository variables (Settings → Variables → Actions):

| Variable            | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| `PROD_API_BASE_URL` | `https://api.yourdomain.com` (bare origin, no `/api`)      |
| `PROD_WS_URL`       | `https://api.yourdomain.com`                               |
| `PROD_RPC_URL`      | `https://rpc.yourdomain.com`                               |
| `PROD_CONSOLE_URL`  | `https://app.yourdomain.com` (helm's own origin)           |
| `PROD_SITE_URL`     | `https://yourdomain.com` (harbor's origin)                 |
| `PROD_TENANT_ID`    | the tenant the console signs in to (registered and active) |

`GITHUB_TOKEN` (automatic) pushes to GHCR. CI-only secrets such as
`SONAR_TOKEN` are covered in [CONTRIBUTING.md](../CONTRIBUTING.md#sonarcloud).

### Ingress and TLS

`infra/k8s/overlays/prod/ingress.yaml` is a single Ingress (`app-ingress`) with
one TLS secret (`app-tls-cert`) for all hosts:

| Host                                   | Service                     | Port  |
| -------------------------------------- | --------------------------- | ----- |
| `yourdomain.com`, `www.yourdomain.com` | `harbor-svc`                | 80    |
| `app.yourdomain.com`                   | `frontend-svc`              | 80    |
| `api.yourdomain.com`                   | `backend-svc` (public role) | 3100  |
| `rpc.yourdomain.com`                   | `backend-svc` (public role) | 50051 |

- **TLS**: the `cert-manager.io/cluster-issuer: letsencrypt-prod` annotation makes cert-manager issue and renew the certificate. Install cert-manager and create a `ClusterIssuer` named `letsencrypt-prod` (Let's Encrypt, HTTP-01) before applying the overlay.
- **WebSocket**: ingress-nginx proxies the WebSocket upgrade by itself; the annotations only raise the read/send timeouts to 3600 s for long-lived Socket.io connections. No snippet annotation is used: ingress-nginx 1.9 and later reject snippets by default, which would fail the whole apply.
- **Body size**: `proxy-body-size: 6m` admits the 5 MB avatar upload plus multipart overhead; the controller default is 1 MB.
- **Controller choice**: the annotations are ingress-nginx specific. The ingress-nginx project is retired upstream (no further releases), so plan a move to another controller (for example Traefik, HAProxy Ingress, or a Gateway API implementation) and translate the timeouts and body size to it; change `ingressClassName` and the `ingress-nginx` namespace label the network policies use.
- **Client addresses**: rate limits and lockouts key on the client IP the backend sees (the right-most `X-Forwarded-For` hop). Behind a cloud load balancer with `externalTrafficPolicy: Cluster` the controller sees a node address instead, so every client shares one limit. Set `externalTrafficPolicy: Local` on the controller's Service, or enable the PROXY protocol on both the load balancer and the controller.
- **Nothing else is routed**: the private role, the worker, the scheduler and every ops port (9464: health and metrics) have no ingress rule. Metrics are not on the public HTTP port at all.
- **RPC**: the browser calls the backend's public RPC listener directly with the Connect protocol, which is plain HTTP/1.1 requests. The ingress forwards `rpc.` straight to `backend-svc:50051` with no gRPC backend-protocol annotation and no translating proxy. CORS for it is the backend's `CORS_ORIGIN` allow-list (`infrastructure/rpc/rpc-cors.ts`). Point helm's `VITE_RPC_URL` at `https://rpc.yourdomain.com`.

### Network policy

`infra/k8s/base/networkpolicy.yaml` default-denies all ingress in the
namespace, then allows:

| Policy                             | Target                                  | Allows                                                                                                                                                                                                    | Ports             |
| ---------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `allow-frontend-from-ingress`      | `app: frontend`                         | ingress from namespace `ingress-nginx`                                                                                                                                                                    | 8080              |
| `allow-harbor-from-ingress`        | `app: harbor`                           | ingress from namespace `ingress-nginx`                                                                                                                                                                    | 4000              |
| `allow-backend`                    | `app: backend-public`                   | ingress from namespace `ingress-nginx` (the `api.` and `rpc.` hosts)                                                                                                                                      | 3100, 50051       |
| `allow-backend-internal-grpc`      | `app: backend-private`                  | ingress only from pods labelled `tropis.io/internal-rpc-client: "true"` (no pod carries it: no backend role calls the internal tier)                                                                      | 50061             |
| `allow-backend-ops`                | `component: backend`                    | ingress from namespace `monitoring` (Prometheus); kubelet probes are not subject to policies                                                                                                              | 9464              |
| `allow-dns-egress`                 | all pods                                | egress to DNS in any namespace                                                                                                                                                                            | 53 UDP/TCP        |
| `allow-backend-egress`             | `component: backend`                    | egress to any destination on the datastore, broker, signing (50052), Vault, OPA, OTel, SMTP and HTTPS ports it uses, including the TLS ports of managed Redis (6380), ClickHouse (8443) and Pulsar (6651) | per port          |
| `allow-internal-rpc-client-egress` | `tropis.io/internal-rpc-client: "true"` | egress to `app: backend-private`                                                                                                                                                                          | 50061             |
| `allow-backup-egress`              | `app: backup`                           | egress to MongoDB, PostgreSQL and ClickHouse HTTP                                                                                                                                                         | 27017, 5432, 8123 |

The internal RPC tier also has its own ClusterIP Service
(`backend-internal-svc`) so the public Service can never route to it, and
callers still need a valid `x-service-token`. A pod that calls the internal
tier gets the label `tropis.io/internal-rpc-client: "true"`, which admits it
through `allow-backend-internal-grpc` and lets it out through
`allow-internal-rpc-client-egress`; nothing else reaches 50061. The policies
assume the ingress controller runs in a namespace labelled
`kubernetes.io/metadata.name=ingress-nginx`.

`allow-dns-egress` selects every pod with `policyTypes: [Egress]`, so under a
CNI that enforces NetworkPolicy every pod is egress-isolated and may send only
what an egress policy allows. frontend and harbor get DNS only, which is
enough because neither opens an outbound connection: helm is static and harbor
renders without calling the backend. `allow-backend-egress` restricts
the backend by port, not by destination, because its datastores run outside
the namespace at addresses the base cannot know; tighten its `to:` with
`ipBlock` CIDRs once a cluster's datastore addresses are fixed. Datastores
outside the cluster need their own allow-lists for the backend's egress
addresses. On a CNI that does not enforce NetworkPolicy, none of these
policies has any effect.

### Autoscaling and disruption budgets

`infra/k8s/overlays/prod/hpa.yaml`:

| HPA                  | Target         | Min–max | Metrics               |
| -------------------- | -------------- | ------- | --------------------- |
| `backend-public-hpa` | backend-public | 3–10    | CPU 70 %, memory 80 % |
| `backend-worker-hpa` | backend-worker | 3–10    | CPU 70 %, memory 80 % |
| `frontend-hpa`       | frontend       | 2–6     | CPU 70 %              |

harbor has no HPA. The HPA targets carry no `replicas` in the overlays
([Overlays](#overlays)). Utilization is measured against the container
`requests`, so keep requests set and tune min/max from load tests (see
[testing.md](testing.md#load-tests)). The cluster needs metrics-server.

backend-public, backend-private, backend-worker, frontend and harbor each have a
PodDisruptionBudget with `minAvailable: 1`. The scheduler has none: a drain
restarts it and the next tick enqueues again.

## Deploying

### Pipeline

A pushed tag matching `v[0-9]+.[0-9]+.[0-9]+` triggers
`.github/workflows/deploy-prod.yml`. It has two jobs, and `deploy` runs only
if `verify` passes. One deploy runs at a time (concurrency group
`deploy-prod`); a second tag waits rather than racing the first rollout.

1. **`verify`**: install with `--frozen-lockfile`, build `@tropis/shared`, lint, backend type check, backend unit tests, build all.
2. **`deploy`**, in order:
   - build the four backend role images (`--target <role>`), the frontend (helm) and harbor images from the repo root and push each to GHCR as `:<tag>` and `:latest` ([Tags and registry](#tags-and-registry)); helm gets its five build args (four URLs and `PROD_TENANT_ID`) and harbor its two `NEXT_PUBLIC_*` args from repository variables ([Frontends](#frontends-endpoints-are-baked-in-at-build-time));
   - write the kubeconfig from `KUBE_CONFIG`, run `kustomize edit set image` in `infra/k8s/overlays/prod` to pin all six images to the tag and `kustomize edit set configmap` to set `SERVICE_VERSION` to it (on the runner only, not committed), then `kubectl apply -k infra/k8s/overlays/prod`;
   - wait for `kubectl rollout status`: each backend role 180 s, frontend 60 s, harbor 90 s;
   - if the rollout step fails, run `kubectl rollout undo` on all six Deployments, wait for them to settle, and exit non-zero so the release is marked failed.

Merging the release PR that release-please maintains
([CONTRIBUTING.md](../CONTRIBUTING.md#deploy)) creates that tag.
`.github/workflows/release-please.yml` runs the action with
`secrets.RELEASE_PLEASE_TOKEN`, falling back to `github.token`. GitHub does not
start workflows for events created by `GITHUB_TOKEN`, so the tag starts
`deploy-prod.yml` only when `RELEASE_PLEASE_TOKEN` holds a personal access
token or GitHub App token that can push tags. Without it, push the tag by hand
from a user account.

### Before a rollout

The pipeline applies manifests only: it runs no migration Job and touches no
data. These steps are the operator's, against the target environment, before
`kubectl apply` or the Argo CD sync of a release that needs them.

1. **PostgreSQL migrations.** The manifests contain no migration Job or
   initContainer, and the backend neither runs them nor creates any table at
   startup (it only verifies the schema and reports `vector` as `down` until it
   matches), so run them from a machine that reaches the database; they are
   forward-compatible
   ([Rollback](#2-database-forward-compatible-migrations-only)), so the running
   release keeps working on the schema they produce:

   ```bash
   DATABASE_URL=postgres://<user>:<password>@<host>:5432/<db> pnpm --filter @tropis/backend migrate:up
   ```

2. **Register every tenant.** Sign-up, login and every token of a tenant that
   is not in the tenant directory are refused, so register each tenant before
   the release that enforces it reaches users, including `PROD_TENANT_ID` and
   `OAUTH_TENANT_ID`:

   ```bash
   MONGODB_URI='<production uri>' make tenant-create ID=<tenant> NAME='<name>'   # SELF_SIGNUP=true only for open sign-up
   ```

   On a database that already holds users, register every tenant they belong
   to at once (self sign-up off, existing directory entries left untouched):

   ```bash
   mongosh '<production uri>' --eval '
     db.users.distinct("tenantId").forEach((id) =>
       db.tenants.updateOne(
         { _id: id },
         { $setOnInsert: { name: id, status: "active", selfSignup: false, createdAt: new Date(), updatedAt: new Date() } },
         { upsert: true },
       ),
     );'
   ```

3. **`API_KEYS` in object form.** Each key must name its tenant:
   `{"<keyId>": {"secret": "...", "tenantId": "<tenant>"}}`. A map of bare
   secrets fails config validation and the backend exits at startup. Convert
   one, binding every key to one tenant, and write it back to the Secret or
   Vault:

   ```bash
   echo "$API_KEYS" | jq -c --arg t <tenant> 'map_values(if type == "string" then {secret: ., tenantId: $t} else . end)'
   ```

4. **`key_shared` subscriptions.** `user-processor-sub` and
   `membership-graph-sub` on `user-events` are `key_shared`, and Pulsar refuses
   a consumer whose type differs from the subscription's while other consumers
   are connected. Where those subscriptions exist as `Shared`, either scale
   `backend-worker` to 0 and then roll out (no backlog is lost), or, once the
   workers holding them have stopped, drop the subscription, which discards
   its unacknowledged backlog:

   ```bash
   kubectl -n tropis scale deploy/backend-worker --replicas=0      # option 1, then roll out
   pulsar-admin topics unsubscribe persistent://public/default/user-events -s user-processor-sub     # option 2
   pulsar-admin topics unsubscribe persistent://public/default/user-events -s membership-graph-sub
   ```

5. **`PROD_TENANT_ID`** is set as a repository variable, because the helm
   image bakes it in at build time ([Frontends](#frontends-endpoints-are-baked-in-at-build-time)).

6. **Renamed event types.** The release emits the user events as
   `identity.user.created` / `updated` / `deleted`. Messages already in
   `user-events`, its `-DLQ` or unrelayed outbox rows under the old names
   `user.created` / `user.updated` / `user.deleted` are still consumed:
   every consumer accepts `LEGACY_EVENT_TYPES` and needs no operator step. A
   consumer outside this repository that matches on the type adds the new
   names before this release. On a cluster that runs an older release, roll
   the worker role first and wait for it
   (`kubectl -n tropis rollout status deployment/backend-worker`) before the
   public and private roles: an older worker does not know the new names and
   would acknowledge and drop them. Removing legacy acceptance is a later step,
   taken only once no old-named message can still arrive
   ([api-conventions.md](api-conventions.md#event-payloads)).
7. **OPA token.** Set `OPA_TOKEN` in the backend Secret (and at
   `secret/tropis` when ESO syncs it) and roll the backend first: an OPA
   without authentication ignores the header. Then roll the `opa`
   Deployment (its image runs with `--authentication=token
--authorization=basic` and `system_authz.rego`, reading the same
   `OPA_TOKEN`); in the other order every authorization check fails as
   `SERVICE_UNAVAILABLE` until the backend has the token.

### Post-deploy verification

```bash
kubectl -n tropis get pods
curl -sf https://api.yourdomain.com/api/health | jq .   # every dependency, as the console's Stack page shows it
kubectl -n tropis port-forward deploy/backend-worker 9464:9464 & curl -sf localhost:9464/readyz | jq .
```

Then compare error rate and latency in Grafana and traces in the tracing
backend against the previous release.

## GitOps with Argo CD

Argo CD watches the repo and syncs the cluster to git instead of CI running
`kubectl apply`. Manifests are in `infra/argocd/`; install and UI access are in
`infra/argocd/README.md`.

| File               | What                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.yaml`     | AppProject `tropis`: this repo only, destination namespace `tropis` only, cluster-scoped kind `Namespace` allowed                                                       |
| `app-prod.yaml`    | Application `tropis-prod`: tracks `infra/k8s/overlays/prod` on `main`, automated sync with `prune` and `selfHeal`, `CreateNamespace=true`, `revisionHistoryLimit: 10`   |
| `app-dev.yaml`     | Optional Application `tropis-dev` for a dev cluster, tracks the base (`infra/k8s`)                                                                                      |
| `app-staging.yaml` | Fully commented Application `tropis-staging` for `infra/k8s/overlays/staging`. Uncomment it and add `tropis-staging` to the `project.yaml` destinations before applying |

Replace the placeholder repo URL in every file first; a private repo also
needs a repo credential (`argocd repo add ...` or a repo Secret). Then:

```bash
kubectl apply -f infra/argocd/project.yaml
kubectl apply -f infra/argocd/app-prod.yaml
```

**Pick one deploy path.** `deploy-prod.yml` pins tags on the runner and applies
them directly, while Argo syncs what is in git, where the overlay says
`newTag: latest`. With both active, Argo's self-heal reverts every CI deploy to
`:latest`. To hand deploys to Argo, edit `deploy-prod.yml`:

1. Uncomment the "Commit image tag bump" step, which commits the pinned `infra/k8s/overlays/prod/kustomization.yaml` to `main`.
2. Remove the kubectl steps (Set up kubeconfig, Install kubectl, Apply prod overlay, Wait for rollout, Rollback on rollout failure).
3. Change the job permission `contents: read` to `contents: write`.

`app-prod.yaml` ignores `/spec/replicas` on the HPA targets (backend-public,
backend-worker, frontend) with `RespectIgnoreDifferences=true`, so self-heal
never scales them back against the HPA.

Argo then detects the commit and rolls it out. CI needs no cluster
credentials, drift from manual `kubectl edit` is reverted, and every deploy is
a git commit that `git revert` undoes. The Argo UI shows per-app health, the
live-vs-git diff, the running image tag and the sync history.

Keeping the manifests in the app repo keeps the whole delivery path readable
in one place. To separate ownership, move `infra/k8s/` into its own repo, point
the Argo Applications at it, and have CI commit the tag bump there.

## Secrets in production

`infra/k8s/base/backend/secret.yaml` holds placeholder values and is for dev
clusters only. It is committed to git; never put real credentials in it.

### External Secrets Operator + Vault

`infra/k8s/base/backend/external-secret.yaml` defines a `SecretStore`
(`vault-backend`, KV v2 mount `secret`, server
`http://vault.vault.svc.cluster.local:8200`) and an `ExternalSecret` that
materializes the `backend-secret` Secret the backend Deployment already reads
via `envFrom`. It maps the same keys as the placeholder `secret.yaml` from the
Vault path `secret/tropis` (seeded by `infra/vault/init.sh`) and refreshes
every hour:

| Key                                                                                    | Empty value means                                                             |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `JWT_SECRET`                                                                           | never empty: at least 32 characters, or the backend refuses to start          |
| `REDIS_PASSWORD`, `CLICKHOUSE_PASSWORD`                                                | no password                                                                   |
| `POSTGRES_PASSWORD`                                                                    | no password; the backup CronJob reads it too                                  |
| `API_KEYS`                                                                             | never empty: `{}` turns the signed tier off; an empty string fails validation |
| `SERVICE_TOKEN`                                                                        | internal RPCs answer `UNIMPLEMENTED`                                          |
| `OPA_TOKEN`                                                                            | no bearer token: a token-protected OPA refuses every authorization check      |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | that OAuth provider stays unconfigured                                        |
| `SMTP_USER`, `SMTP_PASS`                                                               | unauthenticated SMTP                                                          |

Every mapped property must exist at `secret/tropis`, empty or not: one missing
property fails the whole sync and leaves the previous Secret in place. The
OAuth callback URLs and `OAUTH_TENANT_ID` are not secret and live in the
ConfigMap; a callback URL is never set empty, because an empty value replaces
the backend's default instead of falling back to it.

Both resources use `apiVersion: external-secrets.io/v1beta1`. The installed ESO
chart must serve that API version; if it serves only `external-secrets.io/v1`,
change the `apiVersion` of both resources in the manifest to match before
applying. Check what the cluster serves with
`kubectl api-versions | grep external-secrets`.

1. Install ESO:
   ```bash
   helm repo add external-secrets https://charts.external-secrets.io
   helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace
   ```
2. Write every key in the table to Vault: `vault kv put secret/tropis JWT_SECRET=... API_KEYS='{...}' ...`
3. Create the token Secret the `SecretStore` references, using a token scoped to the `tropis-app` policy (`infra/vault/policy.hcl`), never the root token:
   ```bash
   kubectl -n tropis create secret generic vault-token --from-literal=token=<token>
   ```
   Kubernetes auth (`auth.kubernetes` in the `SecretStore`, with `vault auth enable kubernetes` and a role for ESO's service account) removes this static token.
4. In `infra/k8s/base/kustomization.yaml`, replace `backend/secret.yaml` with `backend/external-secret.yaml`.
5. Verify: `kubectl -n tropis get externalsecret backend-secret` reports `SecretSynced`.

Enabling Elasticsearch or MinIO adds their credentials (`ELASTICSEARCH_PASSWORD`,
`MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`) to both `secret.yaml` and the
`ExternalSecret` `data` list.

### Vault from the backend itself

When `VAULT_ADDR` is set, the backend talks to Vault directly: the KV secrets
are merged into the environment before config validation
(`roles/shared/validated-config.ts`), and `VaultSecretsAdapter`
(`infrastructure/secrets/adapters/vault/`) handles token renewal, Transit and
dynamic PostgreSQL credentials; how it behaves
is in [architecture.md](architecture.md#how-the-backend-uses-vault). In
production, authenticate with AppRole (`VAULT_ROLE_ID` + `VAULT_SECRET_ID`),
with the secret-id injected at deploy time and never stored in files.

The merge fills only keys the environment does not set, and runs before
validation, so Vault can supply any key the Joi schema declares (`JWT_SECRET`,
`API_KEYS`, datastore credentials); precedence is environment, then Vault, then
the schema default.

Dynamic PostgreSQL credentials come from the Vault role `tropis-app`
(`infra/vault/init.sh`). Its creation statements create each user
`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` and
`GRANT tropis_tenant_scope TO "{{name}}"`, because row-level security only
holds for a role that cannot bypass it, and `RelationalPort.withTenant()`
must be able to `SET ROLE tropis_tenant_scope`; the revocation statements
revoke those grants before dropping the user. The connection user Vault is
configured with (`database/config/tropis-postgres`) must be able to create
roles and hold `tropis_tenant_scope` `WITH ADMIN OPTION` (PostgreSQL 16 lets a
`CREATEROLE` user grant only roles it administers); it is never the user the
backend runs as.

Run Vault in production mode with HA and auto-unseal: dev mode, which Compose
uses (root token `dev-root-token`), is in-memory and unsealed, so a restart
loses every secret.

### Rotation

**`JWT_SECRET`**: one key signs both access and refresh tokens, and the one
token verifier (`modules/auth/services/token-verifier.service.ts`) checks every
REST, RPC and WebSocket token against it, so rotation is a hard cut that
invalidates every session. Rotate during low
traffic and announce it:

```bash
vault kv patch secret/tropis JWT_SECRET=<new, at least 32 chars>
kubectl -n tropis annotate externalsecret backend-secret force-sync=$(date +%s) --overwrite
kubectl -n tropis rollout restart deployment -l component=backend
```

`kv patch` changes one field; `kv put` replaces the whole secret. Env vars are
read at pod start, so the restart is required after ESO updates the Secret.

**`API_KEYS`** is a JSON map `{ "<keyId>": { "secret": "<secret>", "tenantId": "<tenant>" } }`
(`apps/backend/src/common/guards/api-key.service.ts`), so rotation needs no
downtime: add a new keyId next to the old one, move callers to it (they send it
in `X-Api-Key`), and remove the old keyId once its traffic is zero. The value
is cached per process, so restart the backend after each change.

**Vault**:

- AppRole secret-ids: set `secret_id_ttl`, issue new ones with `vault write -f auth/approle/role/tropis-app/secret-id`, and destroy old ones with `vault write auth/approle/role/tropis-app/secret-id-accessor/destroy secret_id_accessor=<accessor>`.
- Root token: revoke it after setup (`vault token revoke <root>`); regenerate only with `vault operator generate-root` and an unseal-key quorum.
- Unseal keys: rekey periodically and after an operator leaves (`vault operator rekey`).

## Production configuration

Local defaults are for development only. Before production:

| Item            | Local                                        | Production                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`      | `development`                                | `production`: disables Swagger (`/api/docs`) and switches Pino from pretty to JSON logs; Bull Board is never served by a deployed role                                                                                                                                                                                                                                                                                                                                                                                                                |
| `JWT_SECRET`    | dev value in `.env.example`                  | Random 64+ chars from Vault; validation requires at least 32                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CORS_ORIGIN`   | `http://localhost:5173`                      | Comma-separated web origins; the first is used for OAuth redirects. Native origins are always appended ([Native origins and CORS](#native-origins-and-cors))                                                                                                                                                                                                                                                                                                                                                                                          |
| MongoDB         | Single-node replica set                      | 3-node replica set or Atlas ([Production MongoDB](#production-mongodb))                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Redis           | No password                                  | `REDIS_PASSWORD` set; the client has no TLS option, so keep Redis on a private network                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PostgreSQL      | `POSTGRES_SSL=false`                         | `POSTGRES_SSL=true`. The driver then uses TLS and always verifies the server certificate, against `POSTGRES_SSL_CA` (PEM) when set or the system roots otherwise. Leave `TYPEORM_SYNC` unset (it defaults to `false`); migrations own the schema                                                                                                                                                                                                                                                                                                      |
| Object storage  | MinIO (`pgsty/minio`, `MINIO_USE_SSL=false`) | A managed S3 service (AWS S3, Cloudflare R2, GCS in S3 mode) through the same S3-protocol adapter (`OBJECTS_ADAPTER=minio`, `MINIO_ENDPOINT` set to the provider, `MINIO_USE_SSL=true`). No MinIO server runs in production: MinIO publishes no official images, so the `pgsty/minio` build serves local development and tests only                                                                                                                                                                                                                   |
| SMTP            | Mailpit                                      | A real provider via `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| OPA             | Token auth, dev token `tropis-dev-opa-token` | In Kubernetes the `opa` Deployment (`ghcr.io/tropis/opa`, policies baked in) runs with `--authentication=token --authorization=basic`, the policies in `infra/opa/` (including the system policy `system_authz.rego`) and `OPA_TOKEN` in its environment; the backend's `OPA_TOKEN` (Secret) holds the same random value. The system policy admits only that token, plus an unauthenticated `GET /health` for probes; an OPA started without `OPA_TOKEN` answers nothing but `/health`. Keep OPA in-cluster or as a sidecar, unreachable from outside |
| Vault           | Dev mode                                     | Production mode, HA, auto-unseal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| gRPC reflection | Auto-enabled outside production              | Off unless `GRPC_REFLECTION=true`; leave it unset (reflection exposes the full schema)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Logs            | Pino pretty-print                            | JSON to stdout, shipped to your log backend                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Traces          | Jaeger via the OTel collector                | Point `OTEL_EXPORTER_OTLP_ENDPOINT` at your collector or vendor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The base ConfigMap (`infra/k8s/base/backend/configmap.yaml`) sets `PORT`,
`RPC_PUBLIC_PORT`, `RPC_INTERNAL_PORT`, `OPS_PORT`, `NODE_ENV`, `LOG_LEVEL`,
`CORS_ORIGIN`, `MONGODB_URI`, `REDIS_HOST`/`REDIS_PORT`, `CLICKHOUSE_*`,
`PULSAR_SERVICE_URL`, `TEMPORAL_ADDRESS`/`TEMPORAL_NAMESPACE`, `OPA_URL`,
`SMTP_HOST`/`SMTP_PORT` and `OTEL_*`, pointing at placeholder in-cluster names
(`mongodb-svc`, `redis-svc`, `opa-svc`, `smtp-svc`, ...). It also selects every
adapter explicitly: `MESSAGING_ADAPTER=pulsar`, the Redis-backed ports on `redis`,
`OLAP_ADAPTER=clickhouse`, `WORKFLOW_ADAPTER=temporal`, `MAIL_ADAPTER=smtp`,
`STREAM_ENGINE=node`, `SIGNING_ADAPTER=inprocess`, `SECRETS_ADAPTER=env`, and
`VECTOR_ADAPTER`, `SEARCH_ADAPTER`, `OBJECTS_ADAPTER` and `GRAPH_ADAPTER` on
`disabled`, so a deployment runs exactly the capabilities it names and enables
the others on purpose. Any
key it does not set falls back to its default in
`apps/backend/src/config/env.validation.ts`, which for endpoints is
`localhost`. Add the real endpoints for PostgreSQL (`POSTGRES_*`),
Elasticsearch (`ELASTICSEARCH_NODE`), MinIO/S3 (`MINIO_ENDPOINT`, `MINIO_PORT`,
`MINIO_USE_SSL`, `MINIO_BUCKET`) and Aerospike (`AEROSPIKE_HOSTS`, a
`host:port[,host:port]` list) when their adapters are switched on, the real
`OPA_URL` and SMTP endpoint, `OAUTH_TENANT_ID` when OAuth is configured, and,
when `SECRETS_ADAPTER=vault`, `VAULT_ADDR`. A required dependency of a role
(`READINESS_PROBES`) that is unreachable keeps its pods unready; any other is
reported as `degraded`. `infra/k8s/local-kind/host-datastores.yaml` shows the
shape against the Compose datastores. It has no MinIO credentials or bucket,
no Aerospike, `API_KEYS` or `SERVICE_TOKEN`; its `OPA_TOKEN` is the Compose dev token. `SERVICE_VERSION` (the release
tag, reported in logs, traces and metrics) is set by `deploy-prod.yml`, and
`KEYSPACE_ENV` per overlay ([Overlays](#overlays)).
Which managed services can replace each component is in
[tech-decisions.md](tech-decisions.md#vendor-swap-matrix).

### Production MongoDB

Compose runs a single-member replica set (`--replSet rs0`) so change streams
and transactions work in development. It has no redundancy. In production use
a 3-node replica set across zones with `majority` write concern (self-managed
or the MongoDB Kubernetes operator), or MongoDB Atlas, which includes backups,
point-in-time restore and failover.

## Horizontal scaling

Every role is stateless apart from the items below; prod runs backend-public
and backend-worker at 3 replicas and more under the HPAs.

| Concern                                                                        | Multi-replica behaviour                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox relay                                                                   | Runs in every worker replica; a per-aggregate lease in Redis (45 s, renewed every 5 s while a publish is in flight) keeps each aggregate on one replica at a time and its events in order. Safe                              |
| BullMQ jobs                                                                    | Workers claim jobs atomically in Redis. Safe to scale                                                                                                                                                                        |
| Scheduled triggers                                                             | The scheduler only enqueues; job ids are per tick, so extra scheduler replicas enqueue each tick once                                                                                                                        |
| Temporal worker                                                                | Runs in the worker role (`WorkflowWorkerModule`), so workflow capacity scales with worker replicas                                                                                                                           |
| WebSockets                                                                     | With `REALTIME_ADAPTER=redis` (the default) a publish from any process reaches the sockets held by every public replica through Redis pub/sub. The SDK uses the `websocket` transport only, so no sticky sessions are needed |
| Global rate limit                                                              | `@nestjs/throttler` counts through the `ratelimit` port in Redis, so `RATE_LIMIT_DEFAULT` / `RATE_LIMIT_AUTH` / `RATE_LIMIT_REFRESH` hold across every public replica. Safe                                                  |
| Login lockout, sign-up limits, token blacklist, signing nonces, tenant records | Redis. Safe across replicas                                                                                                                                                                                                  |

## Rollback

### 1. Application

```bash
kubectl -n tropis rollout undo deploy/backend-public                  # previous ReplicaSet
kubectl -n tropis rollout undo deploy/backend-public --to-revision=3
kubectl -n tropis set image deploy/backend-public backend=ghcr.io/<owner>/<repo>/backend-public:v1.2.2
```

Repeat for each role (`public`, `private`, `worker`, `scheduler`) that must
move back; roles deployed from different tags must still agree on the
contracts between them.

Deployments keep 10 revisions. Under Argo CD, roll back by reverting the tag
bump commit (`git revert`); a manual `kubectl` rollback is reverted by
self-heal, and a UI rollback requires disabling automated sync first.

An application rollback is only safe because of the next two rules.

### 2. Database: forward-compatible migrations only

PostgreSQL migrations live in `apps/backend/migrations/` (node-pg-migrate;
`pnpm --filter @tropis/backend migrate:up` / `migrate:down`, or `make migrate`).

- **Additive within a release**: add columns, tables and indexes; never drop or rename in the release that stops using them.
- **Two-phase renames**: release N adds the new column and dual-writes; N+1 backfills and switches reads; N+2 drops the old column.
- **Every migration has a working `down`**: `rollout undo` steps the code back, and the schema needs to be able to step back too.
- **The previous app version must run correctly on the new schema.** That makes `rollout undo` a one-liner instead of an incident.

### 3. Events

Event payloads are add-only and consumers tolerate unknown fields, so a
rolled-back producer emitting the older shape is always consumable, and old
events in the Pulsar backlog and the MongoDB outbox are always replayable.
Never rewrite history; emit compensating events.

## Backups and disaster recovery

**Backed up** (data that cannot be recreated):

| Store                                       | Contents                                                  | Tool                                                                       |
| ------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| MongoDB (`tropis_mongodb`)                  | Users, tenants, outbox, event store: the system of record | `mongodump --archive --gzip`                                               |
| PostgreSQL (`tropis_postgres`)              | pgvector embeddings, migration state                      | `pg_dump -Fc`                                                              |
| ClickHouse (`tropis_clickhouse`, db `logs`) | Analytics, tracking and audit history                     | per table `SHOW CREATE TABLE` + `SELECT ... FORMAT Native` (views skipped) |

**Not backed up** (rebuildable or derived):

- **Redis**: cache and rate-limit/lockout counters; a cold start repopulates them.
- **Pulsar**: transient transport; the MongoDB outbox is the source of truth.
- **Elasticsearch**: indexes are re-derivable from MongoDB.
- **Aerospike**: sessions; loss means users sign in again.
- **MinIO**: mirror the bucket separately if uploads matter (`mc mirror local/app-uploads backup/app-uploads`).
- **Temporal's PostgreSQL** (`tropis_temporal_postgres`): workflow history. Back it up like any PostgreSQL if in-flight workflows are business-critical.

**Local (Compose):**

```bash
make backup                        # ./backups/<UTC timestamp>/
make restore TS=20260812-030000    # destructive; asks you to type 'yes'
# optional offsite copy: takes a fresh backup and mirrors it (needs mc on the host)
mc alias set backup https://s3.example.com ACCESS_KEY SECRET_KEY
MC_ALIAS=backup MC_BUCKET=backups ./infra/backup/backup.sh
```

The scripts in `infra/backup/` run with `set -euo pipefail` and refuse to run
unless the three containers are up. `BACKUP_DIR` and the `*_CONTAINER`,
`PG_USER`, `PG_DB`, `CH_DB` variables override the defaults. Restore uses
`mongorestore --drop`, `pg_restore --clean` and truncates ClickHouse tables
before inserting.

**Kubernetes:** `infra/k8s/base/backup/cronjob.yaml` is a template with a
20 Gi `backup-pvc` and one CronJob (`db-backup`) at `0 3 * * *`: `mongodump`
runs as an init container, then `pg_dump`, in the same pod, because the PVC is
`ReadWriteOnce` and two pods mounting it at once can land on different nodes,
where the second never starts. It keeps 14 days on the PVC and has a commented
`mc` upload step. It is not in the kustomization. Configure storage (the PVC, or the S3 upload in
place of it), point `MONGO_URI` and `PGHOST` at the real databases, set
`POSTGRES_PASSWORD` (the key exists, empty, in
`infra/k8s/base/backend/secret.yaml` and is mapped in the `ExternalSecret`), allow the jobs' egress to the databases
([Network policy](#network-policy)), then uncomment `- backup/cronjob.yaml`
in `infra/k8s/base/kustomization.yaml`. ClickHouse is not covered there; use the
ClickHouse operator's `BACKUP ... TO S3(...)` or a clickhouse-backup sidecar.

**Restore drill, quarterly.** A backup that has never been restored is a hope:

1. Start a scratch environment (`make up` on a clean Docker, or a dev cluster).
2. `make restore TS=<latest>` and run the app against it.
3. Check `/api/health` is green, admin login works, the user count matches, and a ClickHouse tracking query returns data.
4. Time the drill and record it; that number is the realistic RTO.

## Deploy checklist

- [ ] Placeholders replaced ([list](#placeholders-to-replace-before-the-first-deploy)), including the `rpc.` host
- [ ] GHCR pull secret attached to the namespace's `default` ServiceAccount if the packages are private ([Tags and registry](#tags-and-registry))
- [ ] `KUBE_CONFIG` set in GitHub secrets; `PROD_API_BASE_URL`, `PROD_WS_URL`, `PROD_RPC_URL`, `PROD_CONSOLE_URL`, `PROD_SITE_URL` and `PROD_TENANT_ID` set as repository variables
- [ ] Every tenant registered and active in the tenant directory, including `PROD_TENANT_ID` and `OAUTH_TENANT_ID` ([Before a rollout](#before-a-rollout))
- [ ] PostgreSQL migrations applied to the target database before the rollout
- [ ] `API_KEYS` in the object form `{"<keyId>": {"secret": ..., "tenantId": ...}}`
- [ ] Release tags trigger `deploy-prod.yml`: `RELEASE_PLEASE_TOKEN` set to a PAT or App token, or tags pushed by hand ([Pipeline](#pipeline))
- [ ] Datastores provisioned (managed or self-hosted) and every endpoint set in the ConfigMap
- [ ] Secrets in Vault, synced by ESO (chart serves `external-secrets.io/v1beta1`, or the manifests moved to `v1`); `backend/secret.yaml` swapped out; every needed key mapped in the `ExternalSecret`; all dev defaults rotated (`JWT_SECRET`, DB passwords, MinIO keys, `OPA_TOKEN`)
- [ ] Ingress controller installed and DNS pointed at its load balancer; client IPs preserved (`externalTrafficPolicy: Local` or PROXY protocol, [Ingress and TLS](#ingress-and-tls))
- [ ] cert-manager and the `letsencrypt-prod` ClusterIssuer in place
- [ ] metrics-server installed (HPAs)
- [ ] If the CNI enforces NetworkPolicy: the ports in `allow-backend-egress` match the datastores in use, and its `to:` tightened to their CIDRs
- [ ] Every dependency each role requires on `/readyz` is reachable, and every adapter the deployment does not run set to `disabled` ([Production configuration](#production-configuration))
- [ ] One deploy path chosen: `deploy-prod.yml` kubectl, or Argo CD with the tag-bump commit
- [ ] Backups scheduled and a restore drill done
- [ ] [security-checklist.md](security-checklist.md) worked through

## Native distribution

The helm web app (`apps/frontend/helm/`) ships to four channels. The PWA is the
default. The native shells (Capacitor for Android and iOS, Tauri for desktop)
wrap the **built** web app from `apps/frontend/helm/dist/` and contain no
business logic; shell layout rules are in
[project-structure.md](project-structure.md#desktop-and-mobile-shells),
and the channel choice in
[tech-decisions.md](tech-decisions.md#frontend-capability-map).

| Channel   | Shell                                                                                   | What ships                     | Updates               |
| --------- | --------------------------------------------------------------------------------------- | ------------------------------ | --------------------- |
| Web / PWA | none (`vite-plugin-pwa`, `registerType: 'autoUpdate'`)                                  | `dist/` on any static host     | instant               |
| Android   | Capacitor 7 (`apps/frontend/helm/android/`, committed Gradle project)                   | APK/AAB embedding `dist/`      | store review          |
| iOS       | Capacitor 7 (`apps/frontend/helm/ios/`, committed Xcode project; `Pods/` is gitignored) | IPA embedding `dist/`          | store review          |
| Desktop   | Tauri v2 (`apps/desktop/`, standalone crate in `src-tauri/`)                            | .app/.dmg/.exe/.deb installers | installer per release |

### Build-time endpoints

The shells load the built web app, so the API endpoints are baked in at
`pnpm build` time from `apps/frontend/helm/.env` (read by `src/lib/env.ts`):
`VITE_API_BASE_URL`, `VITE_WS_URL`, `VITE_RPC_URL`, `VITE_SITE_URL` and
`VITE_TENANT_ID`.

Inside a phone or emulator, `localhost` is the device. For device builds point
them at a backend the device can reach, such as your machine's LAN IP:

```
VITE_API_BASE_URL=http://192.168.1.20:3100
VITE_WS_URL=http://192.168.1.20:3100
VITE_RPC_URL=http://192.168.1.20:50051
```

Then rebuild (`pnpm --filter @tropis/helm build`) and re-sync or re-bundle. On
the Android emulator, `10.0.2.2` is the host.

### Native prerequisites

| Platform | Needs                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PWA      | Node 22+, pnpm                                                                                                                                              |
| Android  | Android Studio + Android SDK 35 (`compileSdk`/`targetSdk` 35, `minSdk` 23), JDK 21                                                                          |
| iOS      | macOS, full Xcode (not only the Command Line Tools), CocoaPods (`brew install cocoapods`)                                                                   |
| Desktop  | Rust toolchain (rustup). Linux also: `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` |

### PWA

```bash
pnpm --filter @tropis/helm build     # dist/ including the manifest and service worker
```

Deploy `dist/` like the web build (the frontend image serves it). The service
worker never caches `/api/`: those requests are `NetworkOnly` and the
navigation fallback excludes them (`vite.config.ts`), so auth and data
responses always come from the backend. PWA requirements are in
[web-quality.md](web-quality.md#pwa).

### Android (Capacitor)

```bash
make android                                     # helm build + cap sync android
pnpm --filter @tropis/helm cap:android           # opens Android Studio: Run, or Build > Generate Signed Bundle
cd apps/frontend/helm/android && ./gradlew assembleDebug   # headless debug APK (needs the SDK)
```

`cap sync` copies `dist/` into `android/app/src/main/assets/public` and links
the native plugins (secure storage, browser, app) into the Gradle project. The config
sets `androidScheme: 'https'`, so the app's origin is `https://localhost`: the
OAuth PKCE challenge (WebCrypto) and the service worker exist only in a secure
context. An https page may not call plain-http endpoints and Android blocks
cleartext traffic, so the http LAN endpoints of
[Build-time endpoints](#build-time-endpoints) need `CAP_DEV_HTTP=1` at
`cap sync` time, which allows mixed content and cleartext. Use it for device
development only and never ship a build synced with it; https endpoints (a TLS
tunnel or a trusted local certificate) need no flag.

### iOS (Capacitor)

The Xcode project, workspace and Podfile are committed; `Pods/` is not, so each
clone runs `pod install`, which needs full Xcode.

```bash
sudo xcode-select --switch /Applications/Xcode.app
sudo xcodebuild -license accept
pnpm install                                     # the Podfile references Capacitor inside node_modules
pnpm --filter @tropis/helm build
cd apps/frontend/helm/ios/App && pod install
cd ../.. && npx cap sync ios
npx cap open ios                                 # Xcode: set the signing team, then Run or Archive
```

### Desktop (Tauri)

```bash
make desktop                                     # installers (runs the helm build first)
cd apps/desktop && pnpm run bundle               # same as make desktop
cd apps/desktop && pnpm run build                # binary only (--no-bundle), no installer tooling
cd apps/desktop && pnpm tauri dev                # window against the Vite dev server
```

`tauri.conf.json` sets `beforeBuildCommand` (helm build), `frontendDist`
(`apps/frontend/helm/dist`), `devUrl` (`http://localhost:5173`) and
`beforeDevCommand` (helm dev server). Installers land in
`apps/desktop/src-tauri/target/release/bundle/` (macOS: `macos/Tropis.app`,
`dmg/Tropis_*.dmg`). Local builds are unsigned; distribution needs code signing
(and notarization on macOS). CI compiles the shell on Linux with
`tauri build --no-bundle` (`ci.yml` `desktop` job).

### Native origins and CORS

The shells serve their bundle from a custom scheme, not a network origin, so
`CORS_ORIGIN` does not cover them. These origins are constants, always allowed
by the backend (`NATIVE_APP_ORIGINS` in
`apps/backend/src/config/cors.constants.ts`, used for REST, Socket.io and the
public RPC listener):

| Client                           | Origin                   |
| -------------------------------- | ------------------------ |
| Desktop (macOS, Linux)           | `tauri://localhost`      |
| Desktop (Windows)                | `http://tauri.localhost` |
| iOS                              | `capacitor://localhost`  |
| Android (default scheme)         | `http://localhost`       |
| Android (`androidScheme: https`) | `https://localhost`      |

Any other gateway in front of the API needs the same five entries. Four of
them (all but `http://localhost`) are also the native session origins that may
receive a refresh token in a body ([Native sessions](#native-sessions)). Without
them each app builds, launches and shows the login screen, then fails at
sign-in with a CORS error.

### Native sessions

The shells' origins are cross-site to the API, so the browser never stores or
sends the `SameSite=Strict` refresh cookie (`tropis_rt`) for them. They keep
the refresh token in OS secure storage instead and use the native session
flow (contract and rules:
[api-conventions.md](api-conventions.md#native-sessions)):

| Shell   | Refresh token                                                                                                                                                                                                                                                                                                                                                                                                              | OAuth start                                                         | OAuth return                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| iOS     | Keychain, `afterFirstUnlockThisDeviceOnly`, never synced (`@aparajita/capacitor-secure-storage` 7.1.6)                                                                                                                                                                                                                                                                                                                     | `@capacitor/browser` 7.0.5 (SFSafariViewController)                 | `tropis` URL type in `ios/App/App/Info.plist` (`CFBundleURLTypes`) → `@capacitor/app` `appUrlOpen`                                    |
| Android | Android Keystore-encrypted storage (same plugin)                                                                                                                                                                                                                                                                                                                                                                           | `@capacitor/browser` (Custom Tabs)                                  | intent filter `tropis://auth/callback` in `android/app/src/main/AndroidManifest.xml` → `appUrlOpen`                                   |
| Desktop | OS keyring through the shell's `session_token_get` / `set` / `clear` commands (`keyring` 4.2: macOS Keychain, Windows Credential Manager, Secret Service; on Linux a Secret Service provider such as GNOME Keyring or KWallet must be running, otherwise the session cannot be stored and native sign-in fails; a failed write after a refresh ends the session at once, because the server has already rotated the token) | `open_oauth_url` (opens only `http(s)://…/api/auth/google\|github`) | `tauri-plugin-deep-link` 2.6 (scheme `tropis` in `tauri.conf.json`), `tauri-plugin-single-instance` forwards it to the running window |

- **Detection**: helm uses the native flow when it runs in a shell
  (`Capacitor.isNativePlatform()` or the Tauri runtime) **and** the page origin
  is a native session origin (`src/lib/native.ts`). `pnpm tauri dev` and
  Capacitor live reload load the Vite dev server, a web origin, so they keep the
  cookie flow.
- **OAuth**: the console opens the provider in the system browser with
  `&redirect=tropis://auth/callback`; the backend returns the one-time code to
  that deep link, the shell routes it to the in-app `/auth/callback`, and the
  code is exchanged with the PKCE verifier like the web flow. The return URL
  must be listed in the backend's `NATIVE_OAUTH_REDIRECTS` (default
  `tropis://auth/callback`). A rebranded app with its own scheme changes the
  scheme in `AndroidManifest.xml`, `Info.plist`, `tauri.conf.json`
  (`plugins.deep-link`), `src-tauri/src/oauth.rs`, `src/lib/native.ts` and
  `NATIVE_OAUTH_REDIRECTS`.
- **Why the OS store**: a refresh token in Web Storage would be readable by any
  script in the webview; the Keychain, Keystore and keyring keep it outside the
  page and tied to the installed app.
- **Desktop permissions**: `capabilities/default.json` grants `core:default`
  and the five shell commands only (an app manifest in `build.rs` makes them
  deny-by-default); the deep-link and opener plugins are used from Rust and
  expose nothing to the page.

To try a device build: point the `VITE_*` endpoints at a reachable backend
([Build-time endpoints](#build-time-endpoints)), build helm, sync or bundle the
shell, sign in with a password, quit and relaunch (the session restores), then
sign in with Google or GitHub (the system browser opens and returns to the
app). An OAuth provider must allow the backend's callback URL, and
`OAUTH_TENANT_ID` must be set ([development.md](development.md#oauth)).

### Desktop content security policy

`apps/desktop/src-tauri/tauri.conf.json` sets `app.security.csp`:
`default-src 'self'`, `script-src 'self'` (Tauri adds the hash of the inline
theme script at build time), `style-src 'self' 'unsafe-inline'` (helm injects
inline styles), `object-src 'none'`, `frame-ancestors 'none'` and a
`connect-src` of `'self'`, the IPC origins and the local default endpoints.
`pnpm run build` / `bundle` in `apps/desktop` first run
`scripts/csp-config.mjs`, which writes `src-tauri/gen/csp.conf.json` with a
`connect-src` naming the endpoints of this build (the `VITE_*` values from
helm's `.env` files and the environment, as Vite reads them), and pass it to
`tauri build --config`. A build without it (`cargo` alone, CI's
`tauri build --no-bundle`) can reach only the local default endpoints.

### Verification status

`cap sync` and `tauri build` succeed, CI compiles the desktop shell, and the
native session code has unit tests (SDK, helm with mocked plugins, the Rust
command wrappers). No CI
job builds the Android or iOS apps, nothing runs them on a device or
simulator, and the desktop window has no visual check. Test on real devices
before shipping a native build.

### Store submission

- **Play Store**: signed AAB from Android Studio to the Play Console. https://developer.android.com/distribute
- **App Store**: Xcode Archive to App Store Connect (Apple Developer Program). https://developer.apple.com/app-store/submissions/
- **macOS outside the App Store**: Developer ID signing + `xcrun notarytool`. https://tauri.app/distribute/sign/macos/
- **Windows / Linux**: MSI/NSIS with Authenticode; .deb/.AppImage need no store. https://tauri.app/distribute/

### Branding checklist

- [ ] Replace `apps/frontend/helm/public/pwa-192x192.png`, `pwa-512x512.png`, `apple-touch-icon.png`, `vite.svg`; update the name and colors in the PWA manifest (`vite.config.ts`) and `theme-color` in `index.html`
- [ ] Regenerate the Tauri icon set from one 1024 px source: `cd apps/desktop && pnpm tauri icon path/to/icon.png` (writes `src-tauri/icons/`, not the Capacitor projects)
- [ ] Replace the Android launcher icons in `apps/frontend/helm/android/app/src/main/res/mipmap-*` (Android Studio Image Asset Studio) and the splash drawables
- [ ] Replace the iOS icons and splash in `apps/frontend/helm/ios/App/App/Assets.xcassets` (`AppIcon.appiconset`, `Splash.imageset`)
- [ ] Change the placeholder id `dev.tropis.app`: `appId` in `apps/frontend/helm/capacitor.config.ts`, `identifier` in `apps/desktop/src-tauri/tauri.conf.json`, `applicationId` and `namespace` in `apps/frontend/helm/android/app/build.gradle`
- [ ] Set the display name: `appName` (`capacitor.config.ts`), `productName` and the window `title` (`tauri.conf.json`), `app_name` in `android/app/src/main/res/values/strings.xml`

## kubectl cheat sheet

```bash
kubectl config current-context                   # which cluster am I talking to?
kubectl get pods -n <ns>                         # what is running or crashing
kubectl describe pod <pod> -n <ns>               # why: read Events first
kubectl logs <pod> -n <ns>                       # container logs (-f to follow)
kubectl get all -n <ns>                          # everything in a namespace
kubectl rollout status deploy/<d> -n <ns>        # is the update done?
kubectl rollout undo deploy/<d> -n <ns>          # back to the previous ReplicaSet
kubectl port-forward svc/<svc> -n <ns> 8088:80   # reach it locally
```

`describe` and `logs` explain most failures. Check the context before anything
destructive.
