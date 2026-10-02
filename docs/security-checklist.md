# Pre-Launch Security Checklist

Work through every item before exposing an environment to real users. "Done" means verified, not assumed. Items marked **Implemented** describe what the repository already provides; the checkbox is still ticked only after verifying it in the target environment.

## Secrets & credentials

- [ ] All default/dev credentials rotated (Mongo, Postgres, Redis, MinIO, Grafana admin, pgAdmin, Vault), including the ones the Compose stack (`infra/docker/docker-compose.yml`) leaves open: the ClickHouse `default` user (empty password), Elasticsearch (`xpack.security.enabled: false`), Temporal Postgres (`temporal`/`temporal`), the OPA dev token (`tropis-dev-opa-token`), and MongoDB and Redis, which run without authentication. Compose binds every published port to `127.0.0.1`, so they are reachable from the host only, never from the network
- [ ] No secrets committed — `infra/k8s/base/backend/secret.yaml` placeholders replaced by External Secrets Operator + Vault (see [deployment.md](deployment.md)); `.env` files gitignored
  - **Implemented (manifest ready)**: ESO `SecretStore` + `ExternalSecret` in `infra/k8s/base/backend/external-secret.yaml`. It is not in the default kustomization; enable it per its header comment (install ESO, create the Vault token secret, swap `backend/secret.yaml` for `backend/external-secret.yaml` in `infra/k8s/base/kustomization.yaml`).
- [ ] **gitleaks** secret scan green in CI and run once over the full git history
  - **Implemented**: the `ci.yml` `secrets` job runs `gitleaks/gitleaks-action` with `fetch-depth: 0` on every push/PR to `main` and `develop`.
- [ ] `JWT_SECRET` is random and **≥ 32 characters** (enforced by Joi in `apps/backend/src/config/env.validation.ts` — `min(32).required()`, no default)
- [ ] Vault: dev mode OFF in production, auto-unseal configured, root token revoked, least-privilege policies (`infra/vault/policy.hcl`) reviewed

## Transport & network

- [ ] TLS on all public endpoints (cert-manager + ingress, `infra/k8s/overlays/prod/ingress.yaml`); HSTS enabled (the backend sends it via `helmet()` defaults)
- [ ] CORS locked to explicit production origins — `CORS_ORIGIN` (comma-separated, parsed by `apps/backend/src/config/cors.constants.ts`); no `*`. The same allow-list guards REST, Socket.io and the public RPC listener (`infrastructure/rpc/rpc-cors.ts`, which echoes only listed origins and does not allow credentials). The fixed native-shell origins (`NATIVE_APP_ORIGINS`: Tauri and Capacitor) are always appended.
- [ ] Rate limiting enabled on auth and public endpoints and verified with a load test
  - **Implemented (REST only)**: `ThrottlerBehindProxyGuard` is a global guard of the public role (`roles/public/public.module.ts`; `trust proxy` set in `roles/shared/http.surface.ts`); the `auth` throttler (`RATE_LIMIT_AUTH` per `RATE_LIMIT_TTL_MS`) applies only to the routes that declare it: login, the OAuth code exchange and the OAuth callbacks (refresh has its own looser `refresh` limit, `RATE_LIMIT_REFRESH`). A rejected request answers `429 RATE_LIMITED` with a `Retry-After` header. The counters live in Redis through the ratelimit port (`common/guards/ratelimit-throttler.storage.ts`), so the limits hold across replicas; they fail open when the store is unavailable. The client address is the right-most `X-Forwarded-For` hop (`trust proxy 1`), so a client cannot pick its own address by sending the header; `X-Real-IP` is ignored. RPC calls never pass through Nest guards (`RpcServer` dispatches them itself), so the throttler does not cover them, and nothing in front of the RPC listener rate-limits.
  - **Implemented (RPC login only)**: `AuthService.Login` (`modules/auth/controllers/auth.rpc.controller.ts`) runs the lockout below and adds its own limit of 10 attempts per email per tenant per 60 s, counted on every attempt through the ratelimit port (one atomic Redis script). It fails open when the rate-limit store is unavailable.
  - **Implemented (sign-up)**: self sign-up (`UserService/Create` without a caller allowed `user:create`, first OAuth sign-in) is counted per client address across tenants (`SIGNUP_RATE_LIMIT_IP`, default 10) and per tenant (`SIGNUP_RATE_LIMIT_TENANT`, default 200) per `SIGNUP_RATE_LIMIT_WINDOW_S` (3600 s), then `RATE_LIMITED`; it fails open when the store is unavailable (`modules/user/services/signup-policy.service.ts`).
  - **Implemented (REST and RPC login)**: login lockout with two counters in 15-min windows — 5 failed attempts per email+IP and 30 per email across all IPs (blunts IP rotation) → 429 before the password check. Counted through the ratelimit port, whose Redis adapter runs `INCR`+`EXPIRE` atomically in one script, so no key is left without a TTL; reset on successful login. It fails open when the ratelimit store is unavailable, because a Redis outage must not lock every user out. The per-email counter has the higher threshold (30) and no hard lock, which limits how far an attacker can lock out a victim by failing logins on their email. `apps/backend/src/modules/auth/services/login-lockout.service.ts`
- [ ] Kubernetes **NetworkPolicies** (`infra/k8s/base/networkpolicy.yaml`): default-deny ingress in the namespace; backend → datastores only; nothing else reaches Mongo/PG/Redis directly
  - Under a CNI that enforces NetworkPolicy every pod is egress-isolated (`allow-dns-egress`); `allow-backend-egress` opens the backend's datastore ports to any destination, so tighten its `to:` with `ipBlock` CIDRs once the addresses are fixed ([deployment.md](deployment.md#network-policy)). The `rpc.` ingress host reaches the backend on 50051 through `allow-backend`. helm and harbor pods get DNS egress only; neither calls the backend from inside the cluster. Datastores outside the cluster need their own allow-lists for the backend's egress addresses.
- [ ] Internal gRPC authenticates callers with transport-level identity (mTLS/SPIFFE) instead of the shared `SERVICE_TOKEN`: a shared secret cannot tell callers apart or be revoked per caller
- [ ] Internal admin UIs (mongo-express, pgAdmin, Kibana, Bull Board, Temporal UI, RedisInsight, CH-UI, Metabase, Pulsar Manager, grpcui) NOT exposed publicly
  - **Implemented**: Bull Board (`infrastructure/jobs/adapters/bullmq/bull-board.ts`, `/api/queues`) has no authentication (Express
    middleware, outside the global JWT guard), so it is mounted only in the `all` role (the local single-process backend) outside
    production, and answers only requests from a loopback address without forwarding headers; deployed roles never serve it.
  - Swagger (`/api/docs`) is served whenever `NODE_ENV` is not `production`, and the prod ingress routes all of `api.<domain>/` to
    the backend. Keep `NODE_ENV=production` (set in `infra/k8s/base/backend/configmap.yaml` and both overlays) in every
    internet-facing environment.

## Containers & supply chain

- [ ] Containers run as **non-root** with a read-only root FS where possible
  - **Implemented**: `USER 1001` in `apps/backend/Dockerfile`, `USER nextjs` in `apps/frontend/harbor/Dockerfile`. The image for helm (the console) sets no `USER`; its nginx listens on 8080, and Kubernetes runs it as uid 101 (`runAsUser: 101` in `infra/k8s/base/frontend/deployment.yaml`); `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `seccompProfile: RuntimeDefault`, all capabilities dropped and `automountServiceAccountToken: false` in the backend, frontend and harbor deployments under `infra/k8s/base/`.
- [ ] Image scanning (**Trivy**) in CI green, and HIGH findings reviewed locally with `trivy image --severity HIGH <image>`
  - **Implemented**: the `ci.yml` Docker jobs build one backend image per role (matrix `public`, `private`, `worker`, `scheduler`) and the helm, harbor and signing images, and fail only on fixable CRITICAL vulnerabilities (`severity: CRITICAL`, `ignore-unfixed: true`); HIGH findings do not fail CI.
- [ ] Dependency audit green (`pnpm audit --prod --audit-level=critical` steps in the `ci.yml` `backend` and `frontend` jobs); Dependabot PRs (`.github/dependabot.yml`) triaged
- [x] **SBOM generation automated**: SPDX SBOMs for each backend role image and the helm, harbor and signing images (Syft via `anchore/sbom-action`) uploaded as CI artifacts (`ci.yml` Docker jobs)
- [x] **Dependency license check automated**: CI fails on GPL-3.0/AGPL-3.0 dependencies (`ci.yml` `licenses` job, `license-checker-rseidelsohn`)
- [ ] Images pinned to immutable tags (semver/SHA), pulled from GHCR only — rollback depends on the previous tag still pointing at the previous image, and a mutable tag can change under a running Deployment
- [x] **CI supply chain**: every workflow action pinned to a commit SHA (a tag can be moved to other code), workflow tokens read-only by default (`permissions: contents: read`, write scopes only on the jobs that need them)

## Code & policy

- [ ] SonarCloud quality gate passing (`sonar-project.properties`); CodeQL SAST job green
  - **Implemented**: `sonar.qualitygate.wait=true` — a failing quality gate fails the CI `sonarcloud` job. The scan step is skipped when no `SONAR_TOKEN` secret is set, so it needs that secret and a linked SonarCloud project to run.
  - **Implemented**: the `ci.yml` `codeql` job runs GitHub CodeQL with the `security-and-quality` queries on push/PR to `main` and `develop`.
- [ ] OPA policies (`infra/opa/authz.rego`) reviewed: default deny, every role→resource→action pair intentional, unit-tested with `opa test` (`infra/opa/*_test.rego`)
- [ ] OPA reachable only from the backend, and run with `--authentication=token --authorization=basic`, the system policy `infra/opa/system_authz.rego` and a random `OPA_TOKEN` in its environment; the backend's `OPA_TOKEN` holds the same value (sent as a bearer token)
  - **Implemented**: Compose and the Kubernetes `opa` Deployment run OPA this way, and CI runs `opa check --strict` and `opa test` on every change (`policy` job); only backend pods reach it (`allow-opa-from-backend`); the system policy admits only that token, plus an unauthenticated `GET /health` for probes, and an OPA without `OPA_TOKEN` admits nothing else (`infra/opa/system_authz_test.rego`, policy conformance with token auth on and off).
  - **Implemented**: an OPA that cannot answer (unreachable, or its circuit open) is `503 SERVICE_UNAVAILABLE`, never a denial, so an outage is retried instead of reported as missing permission (`infrastructure/policy/adapters/opa/opa-policy.adapter.ts`).
- [ ] Revocation and suspension hold on every transport
  - **Implemented**: one `TokenVerifier` (`modules/auth/services/token-verifier.service.ts`) authenticates REST (`JwtAuthGuard`), RPC (the RPC server's authentication interceptor) and the WebSocket handshake: signature and expiry, revocation (`TOKEN_REVOKED_KEY`), the suspension marker, a live `active` member record in the token's tenant whose token version equals the token's `tv` claim, and a registered, active tenant. It fails closed with `SERVICE_UNAVAILABLE` when kv, the member lookup or the tenant directory is down. RPC login runs the REST credential path (lockout, account status, active tenant). Refresh and the OAuth code exchange refuse an inactive account or tenant. Sockets are disconnected at token expiry and re-verified every 60 s.
  - Roles are read from the member record on every verification, never from the token's `roles` claim and never from the profile cache (a cache refill racing a change could serve old values), so a role or status change applies at once on every process.
  - **Implemented**: a password, email, role or status change bumps the account's token version, which ends its sessions: tokens issued before the change fail verification (`AUTH_TOKEN_REVOKED`), and its refresh tokens are refused (`modules/user/repositories/`, `modules/auth/services/auth.service.ts`).
  - **Implemented**: a user changing their own password or email must give the current password (`current_password`, else `403 AUTH_CURRENT_PASSWORD_REQUIRED`), so a stolen session cannot take the account over; an account created through an OAuth provider has none to give (`modules/user/services/user.service.ts`); a wrong current password counts toward the login lockout through the `CREDENTIAL_ATTEMPTS` port (`common/auth/credential-attempts.port.ts`, implemented by `LoginLockoutService`), so a session cannot be used to guess the password.
- [ ] Tenant isolation holds in every store: no default tenant, token tenant authoritative, `X-Tenant-ID` only without a token or matching it, and a fence per store ([architecture.md](architecture.md#multi-tenancy)); conformance suites prove tenant A never reads tenant B
  - The Postgres app user must not be a superuser or hold `BYPASSRLS` outside `withTenant()`, and must be a member of `tropis_tenant_scope` (granted by `infra/postgres/init.sql` / the tenancy migration).
  - **Implemented**: Vault-issued dynamic users (role `tropis-app`, `infra/vault/init.sh`) are created `NOSUPERUSER NOBYPASSRLS` with `GRANT tropis_tenant_scope TO "{{name}}"`. The Vault connection user needs `CREATEROLE` and `tropis_tenant_scope WITH ADMIN OPTION`; the backend never runs as it ([deployment.md](deployment.md#vault-from-the-backend-itself)).
  - **Implemented**: sign-up and login name their tenant with `X-Tenant-ID`, and it must be registered in the tenant directory and active; self sign-up also needs the tenant's `selfSignup` flag. Anonymous callers get one answer whatever the reason, so they cannot probe which tenant ids exist: login answers `AUTH_INVALID_CREDENTIALS` and sign-up `TENANT_SIGNUP_CLOSED`. Tracking ingest and signed ingest accept only a registered, active tenant (for signed requests, the API key's) ([api-conventions.md](api-conventions.md#tenant)). New accounts get the least-privilege `member` role. Keep `selfSignup` off for every tenant whose members an admin adds ([architecture.md](architecture.md#tenant-directory)).
  - OAuth sign-in: the `state` is signed and bound to an HttpOnly `SameSite=Lax` cookie of the browser that started the flow, and the callback hands the console a one-time code (60 s) in the URL fragment instead of a token. The code is bound to a PKCE challenge (`?challenge=` on the start URL) and trades only with its verifier, which only the starting browser holds, and the first exchange attempt spends it.
  - OAuth account pre-hijack: a provider sign-in matches only the account that provider and subject created. When another account already holds the email (password or another provider), the sign-in is refused with `OAUTH_ACCOUNT_EXISTS` and that account is left untouched: there is no email verification, so linking by email would hand the account to whoever registered the address first (`modules/auth/services/oauth.service.ts`).
- [ ] Input validation global, helmet enabled, transformers strip internal fields from all responses
  - **Implemented**: global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true` and `app.use(helmet())` in `apps/backend/src/roles/shared/http.surface.ts`; request bodies capped at 1 MB. Every RPC handler with request fields validates its input through `@RpcValidate` ([api-conventions.md](api-conventions.md#rpc-request-validation)). Avatar uploads are typed from their leading bytes (PNG, JPEG, GIF, WebP; never SVG, which can carry script), and avatar URLs are served with `Content-Disposition: attachment`. Response shaping lives in each module's `transformers/` (e.g. `modules/user/transformers/user.transformer.ts`).

## Client & SDK (`@tropis/sdk`)

- [ ] **Token storage**: the SDK keeps the access token in memory only
      (`packages/sdk/src/auth/token.ts`), never in `localStorage` or
      `sessionStorage`, and the refresh token is the `HttpOnly` `SameSite=Strict`
      cookie `tropis_rt`, which page script cannot read; refresh and logout are
      CSRF-checked ([api-conventions.md](api-conventions.md#session-cookie)). A
      reload restores the session through the cookie. Keep `COOKIE_SECURE` unset or
      `true` in every internet-facing environment. The client-side `exp` check in
      `getToken()` is UX-only; real validation is server-side.
  - **Implemented — short access-token TTL + refresh rotation**: `JWT_EXPIRES_IN`
    defaults to `15m`, so a stolen access token expires fast. The SDK refreshes on
    401 through one single-flight refresher shared by the Connect RPC and REST
    clients (`packages/sdk/src/auth/refresh.ts`, wired in `packages/sdk/src/api.ts`).
    Refresh tokens are HMAC-signed, Redis holds only a SHA-256 hash of the token id,
    and each refresh deletes the old token, so a rotated token is rejected
    (`modules/auth/services/auth.service.ts`). The rotation is one kv `del` that
    reports whether the token existed, so two concurrent refreshes with the same
    token cannot both succeed.
  - **Implemented — native sessions**: the Tauri and Capacitor shells keep the
    refresh token in OS secure storage (Keychain, Android Keystore, desktop OS
    keyring) and use `/api/auth/native/*` with `X-Tropis-Client: native`. The
    backend returns a refresh token in a body only to a native session origin
    that is not a configured web origin, so no web page can obtain one, and
    native OAuth returns only to an allow-listed custom scheme
    (`NATIVE_OAUTH_REDIRECTS`)
    ([api-conventions.md](api-conventions.md#native-sessions)). Keep
    `NATIVE_OAUTH_REDIRECTS` to schemes your shells register, and never add a
    native session origin to `CORS_ORIGIN`.
  - **Implemented — strict CSP**: helm's nginx sends a Content-Security-Policy whose
    only inline script is allowed by its hash and whose `connect-src` is rendered
    per build (`apps/frontend/helm/nginx.conf`, `scripts/render-nginx-conf.mjs`);
    harbor sends its own from `apps/frontend/harbor/next.config.mjs`.
    The desktop shell sets its own CSP in `tauri.conf.json`, with `connect-src`
    rendered per build by `apps/desktop/scripts/csp-config.mjs`.
- [ ] **HMAC request signing verified end-to-end**: SDK signer
      (`packages/sdk/src/signing/`) and backend `SignatureGuard`
      (`apps/backend/src/common/guards/signature.guard.ts`) share one canonical string
      (spec in [api-conventions.md](api-conventions.md)), built over the **raw**
      request bytes; the guard enforces a ±300 s timestamp window, an atomic nonce
      claim on the dedup port (300 s, per key id), and compares signatures in constant
      time through the signing port. API secrets must never ship to a browser — server-to-server only.
  - **Implemented**: the SDK and guard unit tests share one test vector
    (`packages/sdk/src/signing/__tests__/signing.test.ts`,
    `apps/backend/src/common/guards/__tests__/signature.guard.spec.ts`). No
    end-to-end test sends a signed request to a running backend.
- [ ] API-key rotation decided: `ApiKeyService` (`common/guards/api-key.service.ts`)
      reads the `API_KEYS` env map and caches it for the process lifetime, so rotating
      or revoking a key needs a restart. Per-key Vault reads do not exist. Before
      launch, either accept restart-to-rotate, or implement per-key reads under a path
      the `tropis-app` policy grants (it grants only `secret/data/tropis` and
      `secret/data/tropis/*`, e.g. `secret/data/tropis/api-keys/<keyId>`).

## Auditing & recovery

- [ ] Audit logging for sensitive actions (logins, permission changes, deletions) shipped to durable storage
  - **Implemented**: `@Audited(...)` handlers (`user.create`, `user.update`, `user.replace`, `user.delete`, `user.manage_roles`, `user.avatar.upload`, `auth.login`, `auth.logout`) write action, actor (for logout, which is public: the access token's user when one is sent, else the refresh token's, `LogoutActorGuard`), tenant, resource, transport, outcome, error and trace id to ClickHouse `logs.audit_log` via `AuditInterceptor` for HTTP and the RPC server's audit interceptor (`common/audit/`). Schema: `infra/clickhouse/init-audit.sql` (2-year TTL), mounted in `infra/docker/docker-compose.yml` as `04-audit.sql` and applied on first ClickHouse start.
- [ ] Backups configured **and restore-tested** (`infra/backup/`): MongoDB, PostgreSQL and ClickHouse; `infra/backup/` excludes MinIO, so mirror its buckets separately with `mc mirror`; Pulsar retention sized for replay
- [ ] Alerting on auth failure spikes, 5xx rate, and health-check flaps (Prometheus/Grafana, `infra/prometheus/alerts.yml`); in Kubernetes, Prometheus scrapes each backend pod's ops port (`:9464/metrics`, NetworkPolicy `allow-backend-ops` admits the `monitoring` namespace only)
- [ ] Incident contact + vulnerability policy published ([SECURITY.md](../SECURITY.md))
