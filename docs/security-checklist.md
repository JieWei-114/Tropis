# Pre-Launch Security Checklist

Work through every item before exposing an environment to real users. "Done" means verified, not assumed.

## Secrets & credentials

- [ ] All default/dev credentials rotated (Mongo, Postgres, Redis, MinIO, Grafana admin, pgAdmin, Vault)
- [ ] No secrets committed — `infra/k8s/base/backend/secret.yaml` placeholders replaced by External Secrets Operator + Vault (see deployment.md); `.env` files gitignored
  - ✅ **Automated (manifest ready)**: ESO `SecretStore` + `ExternalSecret` available at `infra/k8s/base/backend/external-secret.yaml` — enable per its header comment (install ESO, create vault token secret, swap resource in `base/kustomization.yaml`)
- [ ] **gitleaks** secret scan green in CI (`ci.yml` secrets job) and run once over full git history
  - ✅ **Automated (job wired)**: `ci.yml` `secrets` job runs `gitleaks/gitleaks-action` with `fetch-depth: 0` on every push/PR. Remaining manual step: confirm it runs green once real history exists.
- [ ] `JWT_SECRET` is random and **≥ 32 characters** (enforced by Joi in `src/config/env.validation.ts` — `min(32).required()`)
- [ ] Vault: dev mode OFF in production, auto-unseal configured, root token revoked, least-privilege policies (`infra/vault/policy.hcl`) reviewed

## Transport & network

- [ ] TLS on all public endpoints (cert-manager + ingress; HSTS enabled)
- [ ] CORS locked to explicit production origins (`src/config/cors.constants.ts` + Envoy config) — no `*`
- [ ] Rate limiting enabled on auth and public endpoints (throttler guard) and verified with a load test
  - ✅ **Automated**: login lockout — dual counter: 5 failed attempts per email+IP AND 30 per-email (blunts IP rotation) within 15 min → 429 before password check. Atomic Lua `INCR`+`EXPIRE` (no TTL-less permanent lock). `modules/auth/services/login-lockout.service.ts`, Redis-backed, resets on success
- [ ] Kubernetes **NetworkPolicies**: default-deny in the namespace; backend → datastores only; nothing else reaches Mongo/PG/Redis directly
- [ ] Internal admin UIs (mongo-express, pgAdmin, Kibana, Bull Board, Temporal UI, RedisInsight) NOT exposed publicly

## Containers & supply chain

- [ ] Containers run as **non-root** (`runAsNonRoot: true`, read-only root FS where possible) — check `apps/backend/Dockerfile` USER and pod securityContext
- [ ] Image scanning (**Trivy**) in CI, failing on HIGH/CRITICAL
- [ ] Dependency audit green (`pnpm audit` job in ci.yml); Dependabot PRs triaged
- [x] **SBOM generation automated**: SPDX SBOMs for both images (Syft via `anchore/sbom-action`) uploaded as CI artifacts (`ci.yml` docker job)
- [x] **Dependency license check automated**: CI fails on GPL-3.0/AGPL-3.0 dependencies (`ci.yml` licenses job, `license-checker-rseidelsohn`)
- [ ] Images pinned to immutable tags (semver/SHA), pulled from GHCR only

## Code & policy

- [ ] SonarCloud quality gate passing (`sonar-project.properties`); CodeQL SAST job green
  - ✅ **Automated**: `sonar.qualitygate.wait=true` — a failing quality gate now fails the CI `sonarcloud` job (needs `SONAR_TOKEN` secret + a linked SonarCloud project to actually run)
  - ✅ **Automated (job wired)**: `ci.yml` `codeql` job runs GitHub CodeQL (`javascript-typescript`, `security-and-quality` queries) on every push/PR — no external account needed
- [ ] OPA policies (`infra/opa/authz.rego`) reviewed: default deny, every role→resource→action pair intentional, unit-tested with `opa test`
- [ ] Input validation global (ValidationPipe `whitelist: true`), helmet enabled, transformers strip internal fields from all responses

## Client & SDK (`@tropis/sdk`)

- [ ] **JWT storage is XSS-exposed by design**: the browser token store keeps the
      JWT in `localStorage` (`packages/sdk/src/auth/token.ts`), so any XSS can exfiltrate
      it — `httpOnly` cannot protect it. If moving to `httpOnly` + `Secure` + `SameSite`
      cookies, revisit CSRF protection for the REST/upload routes. The client-side `exp`
      check in `getToken()` is UX-only — real validation is server-side.
  - ✅ **Short access-token TTL + refresh rotation (implemented)**: access token is
    `JWT_EXPIRES_IN=15m` (was 7d), so a stolen access token expires fast. The SDK
    stores a **rotating** refresh token and refreshes-on-401 (single-flight, gRPC-Web
    - REST) — `packages/sdk/src/auth/refresh.ts`. Refresh tokens are HMAC-signed and
      stored **hashed** server-side (`auth.service.ts`); reuse of a rotated token is
      rejected. Remaining hardening: strict CSP (below) and, ideally, httpOnly cookies.
- [x] **HMAC request signing verified end-to-end**: SDK signer
      (`packages/sdk/src/signing/`) and backend `SignatureGuard`
      (`common/guards/signature.guard.ts`) share one canonical string; the guard enforces
      a ±300 s timestamp window, atomic Redis nonce dedup (`SET NX EX 300`, per key id),
      and constant-time (`timingSafeEqual`) comparison over the **raw** request bytes.
      API secrets must never ship to a browser — server-to-server only.
- [ ] API-key rotation: `ApiKeyService` caches the `API_KEYS` env map for the process
      lifetime — rotating/revoking a key needs a restart. For prod, switch to per-key Vault
      reads (`secret/data/api-keys/<keyId>`) so keys rotate without redeploy (noted in the
      service's own header comment).

## Auditing & recovery

- [ ] Audit logging for sensitive actions (logins, permission changes, deletions) shipped to durable storage
  - ✅ **Automated**: `@Audited(...)` handlers (user create/replace/update/delete, auth login/logout, avatar upload) write `{action, actor, tenant, resource, outcome, traceId}` to ClickHouse `logs.audit_log` via `AuditInterceptor` (`common/interceptors/audit.interceptor.ts` + `modules/audit/`). Schema: `infra/clickhouse/init-audit.sql`, mounted in docker-compose as `04-audit.sql` (auto-applied on first ClickHouse start)
- [ ] Backups configured **and restore-tested**: MongoDB, PostgreSQL, MinIO buckets, ClickHouse; Pulsar retention sized for replay
- [ ] Alerting on auth failures spikes, 5xx rate, and health-check flaps (Prometheus/Grafana)
- [ ] Incident contact + vulnerability policy published (SECURITY.md)
