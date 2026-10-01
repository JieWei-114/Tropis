# API Conventions

The single reference for API rules: which transport to use, public vs internal tiers, request signing, the error format, naming and data conventions, contract versioning, and the list of RPCs and HTTP endpoints that exist. System context (components, data flow, event pipeline) lives in [architecture.md](architecture.md); running `grpcurl` / `grpcui` against the listeners is in [development.md](development.md).

## Transport choice

**RPC first.** Every business operation is an RPC method defined in `proto/`, handled in `modules/<feature>/controllers/*.rpc.controller.ts` (decorated with `@RpcService`), and served by the backend's `RpcServer` over Connect, gRPC and gRPC-Web on the same port. The browser calls the public listener directly with the Connect protocol through `@tropis/sdk`; no proxy sits in between. REST fills only the gaps RPC handles poorly; WebSocket carries realtime pushes.

| Transport                      | Use for                                   | Where                                                                                     |
| ------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| RPC (Connect from the browser) | All business operations — the default     | `proto/<domain>/v1/*.proto`                                                               |
| REST (`/api/*`)                | Only the exceptions below                 | NestJS `@Controller`s; global prefix `api` (`config/app.config.ts`)                       |
| WebSocket (Socket.io)          | Server-pushed notifications and live feed | Namespace `/ws` (`modules/websocket/gateways/notification.gateway.ts`), JWT-authenticated |

REST exceptions that exist, and why they are REST:

| Exception                                                                                                                   | Why not RPC                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File upload (`POST /api/users/:id/avatar`)                                                                                  | `multipart/form-data` binary uploads do not map cleanly to protobuf messages                                                                                                                                                                                                                                                                                                                                                            |
| OAuth2 redirects, callbacks and the code exchange (`/api/auth/google`, `/api/auth/github`, `POST /api/auth/oauth/exchange`) | Providers redirect a browser to an HTTP URL, and the exchange completes that browser flow                                                                                                                                                                                                                                                                                                                                               |
| Tracking beacon ingest (`POST /api/v1/track`)                                                                               | The tracker flushes on page unload with `navigator.sendBeacon`, which can only POST plain HTTP                                                                                                                                                                                                                                                                                                                                          |
| Signed server-to-server ingest (`POST /api/v1/track/secure`)                                                                | Machine callers authenticate with [request signing](#request-signing-server-to-server-rest) over plain HTTP                                                                                                                                                                                                                                                                                                                             |
| `/api/health`                                                                                                               | The console's Stack page polls it with plain HTTP. Orchestrator probes and Prometheus use the ops port (`:9464` `/livez`, `/readyz`, `/metrics`), which is not part of the API and no ingress routes                                                                                                                                                                                                                                    |
| Session endpoints (`/api/auth/refresh`, `/api/auth/logout`, `/api/auth/me`, `/api/auth/login`)                              | Browser session handling for the console: login sets and refresh and logout act on the HttpOnly refresh cookie, which RPC does not carry; refresh and logout have no RPC in `auth.proto`                                                                                                                                                                                                                                                |
| Role management (`/api/users/roles`, `/api/users/:id/roles`)                                                                | `UserResponse` in `user.proto` carries no roles field                                                                                                                                                                                                                                                                                                                                                                                   |
| Onboarding workflow view (`GET /api/workflows/onboarding`, admin)                                                           | Console-only read of Temporal workflow state                                                                                                                                                                                                                                                                                                                                                                                            |
| Operator UIs (`/api/queues` Bull Board, `/api/docs` Swagger UI)                                                             | HTML pages served by third-party libraries to a browser, only when `NODE_ENV` is not `production`. Bull Board (`infrastructure/jobs/adapters/bullmq/bull-board.ts`) is Express middleware outside the global `JwtAuthGuard`, so it has no authentication; it is mounted only in the `all` role (`make dev`) and answers only direct requests from localhost. Swagger UI is mounted on the public role by `roles/shared/http.surface.ts` |

Inbound webhooks follow the same rule: no webhook endpoint exists, and when one is added it is REST, because third-party senders speak plain HTTP and cannot call RPC methods.

Rule of thumb: a new endpoint that does not fit a row above is an RPC method.

## Tiers

Every API surface belongs to exactly one of two tiers.

|                | **Public tier**                                                                                                                                | **Internal tier**                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces       | REST under `/api/*` + RPC `tropis.<domain>.v1`                                                                                                 | RPC `tropis.<domain>.internal.v1` only                                                                                                                                                                          |
| Listener       | HTTP `PORT` (default 3100) and RPC `RPC_PUBLIC_PORT` (default 50051), opened by the `public` role; the browser and the ingress point only here | RPC `RPC_INTERNAL_PORT` (default 50061), opened by the `private` role, Kubernetes Service `backend-internal-svc` — never routed by the ingress                                                                  |
| Network        | Internet-facing                                                                                                                                | ClusterIP-only Service + NetworkPolicy `allow-backend-internal-grpc` (ingress on 50061 only from pods labelled `tropis.io/internal-rpc-client: "true"`, which `allow-internal-rpc-client-egress` lets reach it) |
| Auth — users   | JWT bearer token (`modules/auth`); on RPC in the `authorization: Bearer <token>` header                                                        | n/a                                                                                                                                                                                                             |
| Auth — servers | API key + HMAC request signature ([below](#request-signing-server-to-server-rest))                                                             | Service identity: `x-service-token` header                                                                                                                                                                      |
| Proto layout   | `proto/<domain>/v1/<domain>.proto`                                                                                                             | `proto/<domain>/internal/v1/<domain>_internal.proto`                                                                                                                                                            |
| SDK            | Generated into `packages/sdk/src/gen/`                                                                                                         | **Excluded** from SDK codegen (`buf.gen.yaml` `exclude_types`); internal clients generate their own types from the proto                                                                                        |

Tier membership is decided by the proto path: a service under `proto/**/internal/**` is internal, every other contract is public, and the `tiers` option of `@RpcService` overrides it (`infrastructure/rpc/rpc-service.decorator.ts`). `RpcServer` routes each service only on the listener of its tier, so internal RPCs are unreachable on the public port by construction. `tropis.health.v1` is registered on both tiers, and each listener also serves the standard `grpc.health.v1.Health`, so health probes can verify each one.

**Zero-trust rule:** internal calls still authenticate. Port separation decides _exposure_; the `x-service-token` check decides _identity_. "It arrived on the internal port" is a network posture, not an identity. The check is a constant-time compare of `x-service-token` against `SERVICE_TOKEN`:

| Condition                        | RPC status          |
| -------------------------------- | ------------------- |
| `SERVICE_TOKEN` unset (tier off) | `UNIMPLEMENTED`     |
| Token missing or wrong           | `PERMISSION_DENIED` |

The shared `SERVICE_TOKEN` is the portable minimum that works on any network. A single shared secret cannot tell callers apart and cannot be revoked for one caller without rotating it for all, which is why the production replacement is transport-level identity: mTLS / SPIFFE via a service mesh (`user-internal.rpc.controller.ts`, `config/env.validation.ts`).

**Which tier does my RPC go in?**

- Called by a browser, mobile app, or third-party server → **public** (`tropis.<domain>.v1` / `/api/*`).
- Called only by our own services (trusted lookups, bulk/admin operations, data that must never cross the trust boundary, e.g. `GetUserByEmail` without a user JWT) → **internal** (`tropis.<domain>.internal.v1`).
- If in doubt, start internal: promoting to public is add-only; retracting a public RPC is a breaking change.

Example: `tropis.user.internal.v1.UserInternalService.GetUserByEmail` (`proto/user/internal/v1/user_internal.proto`, handler `modules/user/controllers/user-internal.rpc.controller.ts`).

## Crypto terminology — use the right word

| Term                  | Purpose                                                              | Algorithms here                                                                                                 | It is NOT                                                    |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **encode / decode**   | Formatting so data survives a transport (base64, URL-encoding, hex)  | base64, percent-encoding, hex                                                                                   | Security. Anyone can decode. Never call base64 "encryption". |
| **encrypt / decrypt** | Confidentiality — only key holders can read                          | AES-256-GCM via **Vault Transit** (`SecretsPort.encrypt/decrypt`, `src/infrastructure/secrets/`; no caller yet) | Integrity or identity by itself                              |
| **sign / verify**     | Integrity + identity — proves who sent it and that it wasn't altered | HMAC-SHA256 (request signing), HS256 (JWT); Ed25519 (or RS256 for JWT) when verifiers must not be able to sign  | Confidentiality. Signed data is still readable.              |
| **hash**              | One-way fingerprint                                                  | SHA-256 (canonical body hash), bcrypt (passwords)                                                               | Reversible; not encryption                                   |

Rules:

1. **TLS is the mandatory baseline** for every hop. Field-level crypto is _in addition to_, never instead of, TLS.
2. **Field-level encryption of PII goes through Vault Transit** (`SecretsPort.encrypt`, key `user-data`, `aes256-gcm96`, created by `infra/vault/init.sh`). Ciphertext is `vault:v1:...`; key rotation is a Vault operation, not a code change. `encrypt` resolves `null` when encryption is unavailable (Vault down, or `SECRETS_ADAPTER=env`); a caller then redacts the value, never stores it as plaintext.
3. **Never invent crypto.** No hand-rolled ciphers, no custom token formats, no "XOR obfuscation". Use Vault Transit, `node:crypto`, or WebCrypto primitives exactly as specified here.

## Request signing (server-to-server REST)

Authenticates machine callers on public REST endpoints marked `@RequireSignature()` (guard: `common/guards/signature.guard.ts`; client: `@tropis/sdk` → `signRequest` / `createSignedFetch`). The only signed endpoint is `POST /api/v1/track/secure`. `tropis.signing.v1.SigningService` (Rust, `services/rust/signing/`) computes and verifies the same signatures over gRPC; nonce dedup and the tenant checks stay with the caller. Its outcomes are catalog codes: `VerifySignature` answers `valid` plus `reason` (`OK`, `SIGNATURE_EXPIRED`, `API_KEY_UNKNOWN` or `SIGNATURE_INVALID`), and `ComputeSignature` for an unknown key id fails `Unauthenticated` with `google.rpc.ErrorInfo { reason: "API_KEY_UNKNOWN", domain: "tropis" }` (`services/rust/signing/src/error.rs`).

API secrets never ship to a browser. Browsers authenticate with user JWTs.

### Headers

| Header        | Value                                 |
| ------------- | ------------------------------------- |
| `X-Api-Key`   | Key id (identifies the caller)        |
| `X-Timestamp` | Unix **seconds** at signing time      |
| `X-Nonce`     | Unique per request (SDK: UUID)        |
| `X-Signature` | `hex(HMAC-SHA256(secret, canonical))` |

### Canonical string

```
METHOD                \n   # uppercased, e.g. POST
PATH                  \n   # full path incl. /api prefix + query string, e.g. /api/v1/track/secure
X-Timestamp value     \n
X-Nonce value         \n
SHA256(body) as lowercase hex   # hash of the EXACT raw bytes sent; an empty body is hashed too
```

The signature covers the raw request bytes: `roles/shared/http.surface.ts` configures `express.json({ verify })` to capture them on `req.rawBody`. Do not sign a re-serialized `JSON.parse` round-trip; `createSignedFetch` rejects non-string bodies for this reason.

### Server validation (in order)

All failures are `401` with a stable catalog code ([Error codes](#error-codes)), except the tenant checks (steps 5 and 6). A tenant directory that cannot be read answers `503 SERVICE_UNAVAILABLE`.

| Step | Check                                                                                                                                                                   | Failure code                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1    | All four headers present                                                                                                                                                | `SIGNATURE_INVALID`                    |
| 2    | `X-Timestamp` is an integer and `\|now − X-Timestamp\| ≤ 300 s`                                                                                                         | `SIGNATURE_EXPIRED`                    |
| 3    | Key id resolves to a key (`ApiKeyService`)                                                                                                                              | `API_KEY_UNKNOWN`                      |
| 4    | Recomputed signature matches, compared constant-time through the signing port (`SIGNING_ADAPTER`: `inprocess`, or `native` for the Rust service)                        | `SIGNATURE_INVALID`                    |
| 5    | A tenant hint (`X-Tenant-ID` / `?tenant=`), if sent, names the key's tenant (this one is `403`)                                                                         | `TENANT_MISMATCH`                      |
| 6    | The key's tenant is registered (`404`) and active (`403`), so a suspended tenant's keys stop working                                                                    | `TENANT_NOT_FOUND` / `TENANT_INACTIVE` |
| 7    | Nonce unused: atomic claim on the dedup port, key `SIGNATURE_NONCE_KEY.global(keyId, nonce)` (`<app>:<env>:global:dedup:signature:nonce:v1:<keyId>:<nonce>`), TTL 300 s | `NONCE_REUSED`                         |

The signature is verified **before** the nonce is consumed, so a forged request cannot burn a legitimate caller's nonce.

Key storage: `API_KEYS` env var, a JSON map `{ "<keyId>": { "secret": "<secret>", "tenantId": "<tenant>" } }` (default `{}` disables signed endpoints); any other shape fails config validation at startup. Each key is bound to one tenant: a verified request runs in that tenant, and an `X-Tenant-ID` / `?tenant=` naming another tenant is rejected with `403 TENANT_MISMATCH`, so a key can never act for a tenant it was not issued for. The map comes from the environment or Vault, which is merged before validation ([architecture.md](architecture.md#how-the-backend-uses-vault)); it is read once, so rotating a key needs a restart. The Rust `signing` service accepts the same object form (or a bare secret per key id) in its own `API_KEYS`.

Shared test vector: the backend guard spec (`common/guards/__tests__/signature.guard.spec.ts`) and the SDK signing test (`packages/sdk/src/signing/__tests__/signing.test.ts`) pin the same canonical string and signature; changing the scheme means updating both, plus `services/rust/signing/`.

## Errors

Successful REST responses are **not** wrapped: controllers return the payload directly (e.g. `GET /api/users/roles` returns the id → roles map itself). Every error, on every transport, is one entry of the error catalog, `packages/shared/src/errors/catalog.ts` (modelled on AIP-193): a stable `code`, its HTTP status, its Connect code, whether a retry of the unchanged request may succeed, and a public message safe to show an end user. REST, RPC, WebSocket, the SDK and helm all resolve errors through it, so a client switches on `code` alone.

### Raising an error

Business code throws `AppError` (`common/errors/app-error.ts`) with a catalog code: `new AppError('USER_NOT_FOUND')`, `new AppError('FORBIDDEN', { detail })`, or `AppError.validation([{ field, description }])` for field-level failures. `detail` is per-occurrence context and must be as safe to show as the public message (no ids of other tenants, no emails, no internal hosts); `cause` is logged, never sent. Never throw a Nest `HttpException` or a `ConnectError` for a client-visible failure and never invent a code string: add an entry to the catalog and to the table below. Internal invariant violations (tenancy fences, codec and configuration errors) stay plain errors and are answered as `INTERNAL`.

`normalizeError` (`common/errors/normalize.ts`) maps anything thrown to a catalog entry; a Nest exception from the framework (`ValidationPipe`, throttler, body parser) gets the generic code of its status, and anything unanticipated becomes `INTERNAL` and is logged in full with the trace id.

### REST: RFC 9457 problem details

`GlobalExceptionFilter` (`common/filters/http-exception.filter.ts`) answers with `Content-Type: application/problem+json` and the `x-request-id` header set to the trace id; every `429` also carries `Retry-After` in seconds (the thrower's, else 60), which CORS exposes to the browser:

```json
{
  "type": "https://errors.tropis.dev/validation-failed",
  "title": "One or more fields are invalid.",
  "status": 400,
  "detail": "optional, occurrence-specific",
  "instance": "/api/users",
  "code": "VALIDATION_FAILED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "retryable": false,
  "errors": [
    {
      "field": "password",
      "description": "Password must be at least 8 characters"
    }
  ]
}
```

| Member      | Rule                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `type`      | `https://errors.tropis.dev/<code-kebab>`; never `about:blank`, so the code is recoverable from `type` alone         |
| `title`     | The catalog `publicMessage`                                                                                         |
| `status`    | The HTTP status                                                                                                     |
| `detail`    | Present only when the thrower gave a safe detail                                                                    |
| `instance`  | Request path without the query string (it can carry secrets)                                                        |
| `code`      | The catalog code. Clients switch on it, never on status or text                                                     |
| `traceId`   | W3C trace id of the request, equal to the `x-request-id` header                                                     |
| `retryable` | The catalog `retryable`                                                                                             |
| `errors`    | Field violations `{ field, description }`, present for `VALIDATION_FAILED` and other field-level errors             |
| `checks`    | Present on `HEALTH_CHECK_FAILED`: each probe's name and `up`/`down` (probe messages can hold hosts and credentials) |

The type is `ProblemDetails` in `packages/shared/src/errors/problem.ts`.

### Error codes

The catalog is the single source of truth; this table mirrors it and changes with it. A code is never reused for another meaning: one no longer emitted stays in the catalog marked `deprecated` so old clients keep resolving it.

| Code                             | HTTP | Connect code         | Retryable | Raised by                                                                                                                                                                                                                                                       |
| -------------------------------- | ---- | -------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BAD_REQUEST`                    | 400  | `InvalidArgument`    | no        | Generic 400 (malformed JSON body, other 4xx without a code)                                                                                                                                                                                                     |
| `VALIDATION_FAILED`              | 400  | `InvalidArgument`    | no        | `ValidationPipe`, [RPC request validation](#rpc-request-validation), `AppError.validation()` (password floor, avatar file type, invalid `page_token`, OAuth start without a well-formed `?challenge=`)                                                          |
| `FAILED_PRECONDITION`            | 400  | `FailedPrecondition` | no        | Generic                                                                                                                                                                                                                                                         |
| `UNAUTHORIZED`                   | 401  | `Unauthenticated`    | no        | `JwtAuthGuard` / RPC authentication without a token                                                                                                                                                                                                             |
| `FORBIDDEN`                      | 403  | `PermissionDenied`   | no        | `@Authorize` denials (OPA), owner checks (user RPC controller, `UserAvatarService`), internal-tier service token                                                                                                                                                |
| `NOT_FOUND`                      | 404  | `NotFound`           | no        | Unknown route                                                                                                                                                                                                                                                   |
| `METHOD_NOT_ALLOWED`             | 405  | `Unimplemented`      | no        | Generic                                                                                                                                                                                                                                                         |
| `CONFLICT`                       | 409  | `AlreadyExists`      | no        | Generic                                                                                                                                                                                                                                                         |
| `ABORTED`                        | 409  | `Aborted`            | yes       | Generic                                                                                                                                                                                                                                                         |
| `PAYLOAD_TOO_LARGE`              | 413  | `ResourceExhausted`  | no        | Body over 1 MB                                                                                                                                                                                                                                                  |
| `UNSUPPORTED_MEDIA_TYPE`         | 415  | `InvalidArgument`    | no        | Generic                                                                                                                                                                                                                                                         |
| `UNPROCESSABLE`                  | 422  | `InvalidArgument`    | no        | Generic                                                                                                                                                                                                                                                         |
| `RATE_LIMITED`                   | 429  | `ResourceExhausted`  | yes       | HTTP throttlers, RPC login attempt limit, sign-up limits per client address and per tenant                                                                                                                                                                      |
| `CANCELLED`                      | 499  | `Canceled`           | no        | Client cancelled                                                                                                                                                                                                                                                |
| `INTERNAL`                       | 500  | `Internal`           | no        | Any error no thrower anticipated                                                                                                                                                                                                                                |
| `NOT_IMPLEMENTED`                | 501  | `Unimplemented`      | no        | Internal RPC tier with `SERVICE_TOKEN` unset                                                                                                                                                                                                                    |
| `BAD_GATEWAY`                    | 502  | `Unavailable`        | yes       | Generic                                                                                                                                                                                                                                                         |
| `SERVICE_UNAVAILABLE`            | 503  | `Unavailable`        | yes       | `TokenVerifier` store down (fails closed), policy (OPA) unreachable or its circuit open (authorization fails closed, never as a denial), tenant directory unreadable on tracking or signed ingest, open circuit breaker, a failed consumer sink                 |
| `GATEWAY_TIMEOUT`                | 504  | `DeadlineExceeded`   | yes       | Generic                                                                                                                                                                                                                                                         |
| `HEALTH_CHECK_FAILED`            | 503  | `Unavailable`        | yes       | `GET /api/health` with a probe the role requires down (`checks` lists each probe)                                                                                                                                                                               |
| `CAPABILITY_DISABLED`            | 503  | `Unavailable`        | no        | A capability whose adapter is `disabled`                                                                                                                                                                                                                        |
| `TENANT_REQUIRED`                | 400  | `InvalidArgument`    | no        | Tenant-scoped work without a tenant; a job enqueued outside a tenant or global scope                                                                                                                                                                            |
| `TENANT_INVALID`                 | 400  | `InvalidArgument`    | no        | Malformed `X-Tenant-ID` / `?tenant=`                                                                                                                                                                                                                            |
| `TENANT_MISMATCH`                | 403  | `PermissionDenied`   | no        | Tenant hint differs from the token's tenant or from a signed request's API key tenant                                                                                                                                                                           |
| `TENANT_NOT_FOUND`               | 404  | `NotFound`           | no        | Refresh, OAuth sign-in and code exchange, tracking ingest and signed requests (the API key's tenant) for a tenant not registered in the tenant directory                                                                                                        |
| `TENANT_INACTIVE`                | 403  | `PermissionDenied`   | no        | Refresh, OAuth, tracking ingest, signed requests or a verified token in a suspended tenant                                                                                                                                                                      |
| `TENANT_SIGNUP_CLOSED`           | 403  | `PermissionDenied`   | no        | Self sign-up (RPC `Create` without `user:create`) in a tenant that is unregistered, suspended or has `selfSignup` off: one code for all three, so an anonymous caller cannot tell which tenant ids exist; first OAuth sign-in in a tenant with `selfSignup` off |
| `USER_NOT_FOUND`                 | 404  | `NotFound`           | no        | User queries and commands (a malformed id included), `UserService.updateRoles`, avatar endpoints for a non-member, internal `GetUserByEmail`                                                                                                                    |
| `USER_ALREADY_EXISTS`            | 409  | `AlreadyExists`      | no        | `CreateUserCommand` (pre-check and unique-index race)                                                                                                                                                                                                           |
| `USER_LAST_ADMIN`                | 409  | `FailedPrecondition` | no        | Removing the admin role from, deactivating or deleting the last admin of a tenant (checked atomically in the write transaction)                                                                                                                                 |
| `AUTH_INVALID_CREDENTIALS`       | 401  | `Unauthenticated`    | no        | REST and RPC login, including a login that names an unregistered or suspended tenant                                                                                                                                                                            |
| `AUTH_TOKEN_INVALID`             | 401  | `Unauthenticated`    | no        | `TokenVerifier`, refresh (malformed or unknown refresh cookie; the response clears the cookie; no cookie at all is `204`)                                                                                                                                       |
| `AUTH_TOKEN_REVOKED`             | 401  | `Unauthenticated`    | no        | `TokenVerifier` and refresh: a logged-out access token, an already rotated refresh token, or a token whose `tv` is older than the account's token version                                                                                                       |
| `AUTH_ACCOUNT_INACTIVE`          | 401  | `Unauthenticated`    | no        | Login, refresh, OAuth, `TokenVerifier`                                                                                                                                                                                                                          |
| `AUTH_LOGIN_LOCKED`              | 429  | `ResourceExhausted`  | yes       | `LoginLockoutService`                                                                                                                                                                                                                                           |
| `AUTH_CSRF_REJECTED`             | 403  | `PermissionDenied`   | no        | `CookieCsrfGuard` on refresh and logout: no `X-Tropis-Client: 1`, or not from an allowed origin                                                                                                                                                                 |
| `AUTH_CURRENT_PASSWORD_REQUIRED` | 403  | `PermissionDenied`   | no        | User `Update` / `Replace` that changes the caller's own password or email without the correct `current_password`                                                                                                                                                |
| `OAUTH_ACCOUNT_EXISTS`           | 409  | `AlreadyExists`      | no        | OAuth callback for an email another account holds (password or another provider); answered as problem+json, the account is left untouched                                                                                                                       |
| `OAUTH_NOT_CONFIGURED`           | 501  | `Unimplemented`      | no        | `OAuthConfiguredGuard` (provider client id/secret unset)                                                                                                                                                                                                        |
| `OAUTH_STATE_INVALID`            | 400  | `InvalidArgument`    | no        | OAuth callback whose `state` is tampered, expired, not bound to the browser's state cookie or carries no PKCE challenge                                                                                                                                         |
| `OAUTH_CODE_INVALID`             | 401  | `Unauthenticated`    | no        | `POST /api/auth/oauth/exchange` with an unknown, used or expired code, or a `verifier` that does not match the code's challenge                                                                                                                                 |
| `API_KEY_UNKNOWN`                | 401  | `Unauthenticated`    | no        | `SignatureGuard`                                                                                                                                                                                                                                                |
| `SIGNATURE_INVALID`              | 401  | `Unauthenticated`    | no        | `SignatureGuard`                                                                                                                                                                                                                                                |
| `SIGNATURE_EXPIRED`              | 401  | `Unauthenticated`    | no        | `SignatureGuard`                                                                                                                                                                                                                                                |
| `NONCE_REUSED`                   | 401  | `Unauthenticated`    | no        | `SignatureGuard`                                                                                                                                                                                                                                                |
| `INTERNAL_ERROR`                 | 500  | `Internal`           | no        | Deprecated, replaced by `INTERNAL`; never emitted                                                                                                                                                                                                               |
| `HTTP_ERROR`                     | 500  | `Unknown`            | no        | Deprecated, replaced by `BAD_REQUEST`; never emitted                                                                                                                                                                                                            |

### RPC errors

The RPC errors interceptor (`infrastructure/rpc/interceptors/errors.interceptor.ts`) maps whatever a handler throws through `mapRpcError` (`infrastructure/rpc/rpc-errors.ts`) to a `ConnectError` in the AIP-193 shape: the status is the catalog entry's `rpcCode` (`packages/shared/src/errors/catalog.ts`), the message is the thrower's safe `detail` or else the entry's `publicMessage`, and the details carry `google.rpc.ErrorInfo { reason: <code>, domain: "tropis", metadata.retryable }` plus `google.rpc.BadRequest` for field violations. A `ConnectError` thrown by a handler keeps its code and message and gains the `ErrorInfo` of its code when it carries none. An error no thrower anticipated is answered as `INTERNAL` with the generic message and logged in full with the trace id. The interceptor runs on both RPC listeners; Nest's HTTP exception filters do not apply to RPC calls.

### RPC request validation

Nest's `ValidationPipe` does not see RPC calls, so RPC input has its own layer. Every handler whose request message has fields declares the class-validator DTO it is checked against with `@RpcValidate(Dto)` (`infrastructure/rpc/rpc-validate.decorator.ts`); `RpcServer` refuses to start when such a handler declares none, so no RPC reaches business code unchecked. The validation interceptor (`infrastructure/rpc/interceptors/validation.interceptor.ts`) is the innermost one, after authentication and authorization, so an anonymous caller learns nothing about a protected method's input. It checks unary requests and rejects an invalid one with `VALIDATION_FAILED` and one `google.rpc.BadRequest` field violation per failed rule.

DTO properties use the generated (camelCase) field names; violations report the proto (snake_case) field names, the names clients see in the contract. proto3 has no absent scalar (an omitted string is `''`, an omitted number `0`), so a field whose zero value means "not set" is marked `@ProtoOptional()`, and its other rules apply only to a value the caller gave.

## Parameter & data conventions

| Topic       | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON names  | `camelCase` in bodies and query params (`eventName`, `anonymousId`) (the JavaScript/TypeScript convention, so bodies map to objects without renaming)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Proto names | `snake_case` fields (`login_count`, `idempotency_key`), enforced by buf lint. Handlers use the protobuf-es types generated into `src/gen/`, whose fields are lowerCamelCase (`loginCount`); transformers map at the boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Timestamps  | Proto data timestamps are `google.protobuf.Timestamp` (`event_time` in `tracking.proto` and `analytics.proto`, `cache_time`, `last_seen_time`, `window_start_time`); the epoch-millisecond `int64` fields they replace (`timestamp`, `cached_at`, `last_seen`, `window_ms`) are deprecated and still filled with the same instant. JSON bodies carry ISO 8601 UTC strings with a trailing `Z` (`health.proto` `timestamp` is an ISO string too); the exceptions are tracking ingest `timestamp` (epoch ms `number`, set by the client) and `startTime` / `closeTime` of `GET /api/workflows/onboarding` (epoch ms). `X-Timestamp` in request signing is unix **seconds**, by spec, and so are the `timestamp` fields in `proto/signing/v1/signing.proto`, for the same reason |
| Money       | Integer minor units (cents/sen) in `int64` / `number`, plus an explicit currency code. **Never floats**: `0.1 + 0.2 !== 0.3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Pagination  | AIP-158: a list request takes `page_size` (0 means the server default) and `page_token` (the previous response's `next_page_token`, empty for the first page); the response carries `next_page_token` (empty on the last page) and `total_size` (proto `FindAllRequest` / `UsersResponse`). The page token is opaque; an invalid one is `VALIDATION_FAILED` on `page_token`. `page`, `limit`, `total`, `total_pages` (and `size` / `limit` on `Search` / `FindSimilar`) are deprecated, still answered, and ignored when a request sets `page_size` or `page_token`. Handlers clamp the page size (`FindAll`: default 20, max 100; `Search`: 10, max 50; `FindSimilar`: 5, max 50) so one request cannot pull the whole collection                                            |
| IDs         | Opaque strings. Never expose Mongo `_id` / `__v`: transformers (`modules/user/transformers/user.transformer.ts`) emit `id` and an explicit field list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Idempotency | Retry-safe creates take an idempotency key (`CreateUserRequest.idempotency_key`: the same key from the same caller within 24 h returns the cached response). The key is scoped to the caller (`user:<id>` when authenticated, `ip:<address>` otherwise), so one caller can never receive another's stored response                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Tenant

Every call runs in one tenant. A verified access token names it; a call without a token names it with `X-Tenant-ID` (REST, RPC; the tracking beacon may use `?tenant=` instead, because `navigator.sendBeacon` cannot set headers). On a call with a token the header is optional and, when sent, must equal the token's tenant (`403 TENANT_MISMATCH`). There is no default tenant: tenant-scoped work that names none answers `400 TENANT_REQUIRED`. A request signed with an API key runs in the key's tenant, and a hint naming another is `403 TENANT_MISMATCH`. The tenant must be registered and active for sign-up, login, refresh, OAuth, tracking ingest, signed requests and every verified token. Anonymous entry points answer uniformly, so a caller cannot tell which tenant ids exist: login with an unregistered or suspended tenant is `401 AUTH_INVALID_CREDENTIALS`, and self sign-up into an unregistered, suspended or closed (`selfSignup` off) tenant is `403 TENANT_SIGNUP_CLOSED`. Refresh, OAuth, tracking ingest and signed requests answer `404 TENANT_NOT_FOUND` / `403 TENANT_INACTIVE`; a verified token whose tenant is not registered is `401 AUTH_TOKEN_INVALID`, and one in a suspended tenant `403 TENANT_INACTIVE`. The SDK sends `X-Tenant-ID` from its `tenantId` option (`createApi`, `createSdk`, `createRestClient`) and the tracker adds `?tenant=`. Resolution rules and why: [architecture.md](architecture.md#multi-tenancy).

## Versioning and compatibility

Applies to gRPC, REST, and event payloads. The principle everywhere: **within a version, changes are add-only**; anything else is a new version.

### gRPC / Protobuf

Layout: `proto/<domain>/v1/<domain>.proto` declares `package tropis.<domain>.v1;` (e.g. `proto/user/v1/user.proto`). Domains: `auth`, `user`, `analytics`, `tracking`, `signing`, `health`, plus the internal `proto/user/internal/v1/`. `proto/grpc/` (health, reflection) and `proto/google/rpc/` (error details) are vendored upstream contracts, excluded from `buf lint` and kept under their canonical names. Types are generated with buf (`make proto` → `packages/sdk/src/gen/` for the public tier, `apps/backend/src/gen/` for everything the backend serves).

Compatibility rules within a version (the internal tier follows the same rules):

1. **Only add fields.** Never remove a field, never change the type or meaning of an existing one.
2. **Never reuse field numbers.** A removed field is reserved forever, by number and name: `reserved 5; reserved "old_name";`.
3. **Treat renames as breaking.** The binary wire format uses numbers, but JSON uses names and generated code breaks callers.
4. **Semantic change ⇒ new version.** If a field meant cents and now means dollars, that is `tropis.<domain>.v2`, not a doc comment.
5. **Never delete or rename an RPC, service, or message** in a published version.

### Enforcement

| Check                        | Where                                                                                                             | What it catches                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buf lint` (`STANDARD`)      | CI job "Proto — buf lint & breaking", every run                                                                   | Naming and style. Exceptions in `buf.yaml`: `RPC_REQUEST_RESPONSE_UNIQUE`, `RPC_REQUEST_STANDARD_NAME`, `RPC_RESPONSE_STANDARD_NAME`, `PACKAGE_DIRECTORY_MATCH` (the layout above has no `tropis/` directory) |
| `buf breaking` (`WIRE_JSON`) | Same job, pull requests only: `buf breaking --against '.git#branch=main'`                                         | Changes that break binary wire or JSON encoding (field number/type changes, deleting a field without reserving it). A PR that breaks wire compatibility fails                                                 |
| Codegen drift                | Same job: `buf generate` then `git status --porcelain -- packages/sdk/src/gen apps/backend/src/gen` must be empty | Proto changes committed without regenerating (or without committing) the SDK and backend types                                                                                                                |

`WIRE_JSON` does not flag source-level breaks such as a deleted or renamed RPC or service; rule 5 is enforced in review. Run `buf lint` and `buf breaking` locally before pushing.

### REST

- The global prefix is `api` (`app.setGlobalPrefix(API_PREFIX)` in `roles/shared/http.surface.ts`). URI versioning is not enabled in Nest; the version segment is part of the controller path (`@Controller('v1/track')` → `/api/v1/track`).
- Tracking ingest is the only versioned REST surface, because it is the one REST surface third parties call. The other REST routes are unversioned because they are infrastructure (`/api/health`) or console-only endpoints consumed by our own frontend (`/api/auth/*`, `/api/users/*`, `/api/workflows/onboarding`). A route that gains an external consumer gets a version segment.
- Same add-only rules as proto: new optional fields are fine; removing, renaming or retyping a field ⇒ a `v2` path.

### Breaking changes (v1/v2 coexistence)

When a breaking change is unavoidable:

1. **Parallel handlers, shared services.** The v2 controller (`@Controller('v2/...')`) and the `tropis.<domain>.v2` proto handler sit next to v1; both call the _same_ service layer, and only DTOs/transformers differ.
2. **Deprecate loudly:**
   - REST v1 responses send `Deprecation: true` and `Sunset: <RFC 1123 date>` headers.
   - gRPC v1 methods get `option deprecated = true;` in the proto.
   - SDK/shared types get `@deprecated` JSDoc naming the replacement.
3. **Deletion window:** announce a sunset date, watch v1 traffic (`tropis_http_server_requests_total` per route, RPC RED metrics per method), and delete v1 only when traffic is zero **and** the window has closed.

| Change                 | Action                                  |
| ---------------------- | --------------------------------------- |
| Add optional field     | Allowed in v1                           |
| Add new RPC/endpoint   | Allowed in v1                           |
| Remove/rename field    | v2 package/path + coexistence           |
| Change field semantics | v2 package/path + coexistence           |
| Delete v1              | Only after sunset window + zero traffic |

### Event payloads

Every message on the event bus is a CloudEvents 1.0 envelope (`EventEnvelope`, `packages/shared/src/events/envelope.ts`) in binary mode: `specversion`, `id`, `source`, `type`, `time`, `subject`, `datacontenttype`, `dataschema` (when set), `tenantid` and `schemaversion` travel as `ce_<attribute>` message properties, `traceparent` / `tracestate` under their own names, and the body is `data` unchanged. How the outbox relay and the consumers use it: [architecture.md](architecture.md#event-pipeline). The `data` shapes, the user events contract (`packages/shared/src/events/user-events.ts`) and the analytics event data (Flink mirror `services/flink/src/main/java/com/app/flink/models/AppEvent.java`), follow the same add-only rule:

- Producers may add fields.
- Consumers (Flink jobs, the backend's consumers) MUST ignore unknown fields and MUST NOT require new fields from old events still in the broker backlog or in the event store (MongoDB collection `user_event_store`).
- A breaking change to `data` bumps the envelope `schemaversion`; a changed stored-event shape also bumps the stored `schemaVersion` and gets a `migratePayload` branch (`modules/user/event-store/user-event-store.service.ts`), so replays read old events in the current shape.
- `type` is never reused for a different shape; a payload that no longer fits its type is a new type added to `EVENT_TYPES`. New types follow `<domain>.<entity>.<past-tense-verb>` (`isConformingEventType` in `envelope.ts`); the published `user.created` / `user.updated` / `user.deleted` keep their names and are listed in `LEGACY_EVENT_TYPES` (`packages/shared/src/events/event-types.ts`), the only types exempt from the pattern.

Event-name strings come only from `EVENT_TYPES` / `ANALYTICS_EVENT_TYPES` in `@tropis/shared`. Tracking event names and properties are specified in [tracking-plan.md](tracking-plan.md).

### Distributing contracts

| Consumer                   | How                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apps in this monorepo      | `"@tropis/sdk": "workspace:*"`; TypeScript source consumed directly through the package `exports` map (`packages/sdk/src/index.ts`), no build step                                                                  |
| Anything outside this repo | Not distributed: `@tropis/sdk` is `"private": true`, and the manual `publish.yml` workflow (npm publish, `buf push` to `buf.build/tropis/tropis`) skips each job unless its `NPM_TOKEN` / `BUF_TOKEN` secret exists |

Non-TypeScript consumers generate their own code from the proto module rather than consuming our generated code. The internal tier (`proto/user/internal/**`) is part of the buf module.

#### Enabling external distribution

`.github/workflows/publish.yml` runs only on manual dispatch (`workflow_dispatch`, with `publish_npm` and `push_bsr` inputs). Each job first checks that its secret exists and skips cleanly when it does not.

npm (`@tropis/sdk`):

1. Remove `"private": true` from `packages/sdk/package.json`.
2. Set its `version` to the repo release version (release-please manages the root `package.json` version; the SDK version is not bumped automatically).
3. Add the `NPM_TOKEN` repository secret.
4. Run the publish workflow with `publish_npm`. It builds `dist/` (`pnpm --filter @tropis/sdk build`) and runs `pnpm publish --provenance`; `publishConfig` points published consumers at `dist/` instead of `src/`.

Buf Schema Registry:

1. Set `modules[].name` in `buf.yaml` to the real BSR module (`buf.build/tropis/tropis` is a placeholder).
2. Add the `BUF_TOKEN` repository secret.
3. Run the publish workflow with `push_bsr`, which runs `buf push` through `bufbuild/buf-action`.
4. Consumers add the module to `deps` in their own `buf.yaml` and run `buf generate`.

The internal tier is part of the module, so keep the BSR repository private if it must stay inside the organisation.

## API reference

The proto files are the source of truth for every message and field; this section lists what exists. Swagger UI (`/api/docs`) is served outside production; RPC server reflection (`infrastructure/rpc/reflection.ts`) is on outside production and opt-in with `GRPC_REFLECTION=true` (see [development.md](development.md)). The ops port (`OPS_PORT`, default 9464: `/livez`, `/readyz`, `/metrics`) runs on every role but is not part of the API: [deployment.md](deployment.md).

### Listeners

| Listener             | Env var (default)                             | Role             | Serves                                                                                              |
| -------------------- | --------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| HTTP                 | `PORT` (3100)                                 | `public`         | REST under `/api`, Swagger at `/api/docs` (non-production), Socket.io namespace `/ws`               |
| RPC public           | `RPC_PUBLIC_PORT` (50051)                     | `public`         | `tropis.auth.v1`, `tropis.user.v1`, `tropis.analytics.v1`, `tropis.tracking.v1`, `tropis.health.v1` |
| RPC internal         | `RPC_INTERNAL_PORT` (50061)                   | `private`        | `tropis.user.internal.v1`, `tropis.health.v1`                                                       |
| Rust signing service | `GRPC_PORT` (50052), `services/rust/signing/` | separate service | `tropis.signing.v1`                                                                                 |

The `all` role (`make dev`, e2e) opens every backend listener in one process. Both RPC listeners also serve `grpc.health.v1.Health` and, when enabled, server reflection.

### RPC services

Auth: RPCs marked JWT read the token from the `authorization: Bearer <token>` header. Every JWT RPC except `AuthService.GetCurrentUser` carries `@Authorize(resource, action)`, which the RPC authorization interceptor checks through OPA (`infra/opa/authz.rego`) before the handler runs, with the action in parentheses; `GetCurrentUser` only verifies the token (`auth.rpc.controller.ts`). RPCs marked none take no token.

| Service                                       | RPC                | Auth                          | Purpose                                                                                                           |
| --------------------------------------------- | ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tropis.auth.v1.AuthService`                  | `Login`            | none                          | Email + password → access token; the REST lockout plus 10 attempts per 60 s per email (then `RESOURCE_EXHAUSTED`) |
|                                               | `GetCurrentUser`   | JWT (verify only, no OPA)     | Identity from the token                                                                                           |
| `tropis.user.v1.UserService`                  | `Create`           | none (self-registration)      | Sign-up; honors `idempotency_key`                                                                                 |
|                                               | `FindAll`          | JWT (`list`)                  | Paginated list                                                                                                    |
|                                               | `FindById`         | JWT (`read`, self or admin)   | One user                                                                                                          |
|                                               | `GetMe`            | JWT (`read`)                  | The caller                                                                                                        |
|                                               | `Update`           | JWT (`update`, self or admin) | Partial update                                                                                                    |
|                                               | `Replace`          | JWT (`update`, self or admin) | Full replace                                                                                                      |
|                                               | `Delete`           | JWT (`delete`)                | Soft delete                                                                                                       |
|                                               | `Search`           | JWT (`list`)                  | Elasticsearch full-text search                                                                                    |
|                                               | `FindSimilar`      | JWT (`list`)                  | pgvector similarity                                                                                               |
| `tropis.analytics.v1.AnalyticsService`        | `CreateEvent`      | JWT (`write`)                 | Record an analytics event                                                                                         |
|                                               | `GetStats`         | JWT (`read`)                  | Counts by event type (cached)                                                                                     |
|                                               | `GetRecent`        | JWT (`read`)                  | Recent events                                                                                                     |
|                                               | `GetMinutelyStats` | JWT (`read`)                  | Per-minute counts                                                                                                 |
| `tropis.tracking.v1.TrackingService`          | `GetInsights`      | JWT (`read`)                  | Behavior insights over tracked events                                                                             |
| `tropis.health.v1.HealthService`              | `Check`            | none                          | Liveness (both listeners)                                                                                         |
| `tropis.signing.v1.SigningService`            | `ComputeSignature` | —                             | HMAC signature for a canonical request                                                                            |
|                                               | `VerifySignature`  | —                             | Verify a signature within the ±300 s window                                                                       |
| `tropis.user.internal.v1.UserInternalService` | `GetUserByEmail`   | `x-service-token`             | Trusted lookup by email for our own services                                                                      |

### HTTP endpoints

All routes carry the `/api` prefix. The global `JwtAuthGuard` authenticates every route; `@Public()` is the explicit opt-out.

| Method | Path                        | Auth                                             | Response / notes                                                                                                                                                                                                                                                                    |
| ------ | --------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`               | public                                           | Every capability and connection with its adapter, for the console's Stack page; `503 HEALTH_CHECK_FAILED` only when a probe the role requires is down, others listed in `degraded`; rate-limited by `RATE_LIMIT_DEFAULT`                                                            |
| POST   | `/api/auth/login`           | public                                           | `200 { accessToken }` and sets the [refresh cookie](#session-cookie); `RATE_LIMIT_AUTH`                                                                                                                                                                                             |
| POST   | `/api/auth/refresh`         | public, [CSRF-checked](#session-cookie)          | No body: reads the refresh cookie, rotates it and returns `{ accessToken }`; without a cookie `204` (no session, so restoring on page load is not an error); an unknown or invalid cookie is `401 AUTH_TOKEN_INVALID` and clears it; `RATE_LIMIT_REFRESH`                           |
| POST   | `/api/auth/logout`          | public, [CSRF-checked](#session-cookie)          | `204`; revokes the bearer access token when one is sent and the cookie's refresh token, and clears the cookie                                                                                                                                                                       |
| GET    | `/api/auth/me`              | JWT                                              | `{ userId, email, tenantId, roles }`, roles from the live member record                                                                                                                                                                                                             |
| GET    | `/api/auth/google`          | public                                           | Requires `?challenge=<base64url(SHA-256(verifier))>`, the PKCE challenge of a verifier the browser keeps (`400 VALIDATION_FAILED` without a well-formed one); redirects to Google consent; `501 OAUTH_NOT_CONFIGURED` when unset                                                    |
| GET    | `/api/auth/google/callback` | public                                           | Checks the signed `state` against its cookie (`400 OAUTH_STATE_INVALID`), then redirects to `<web app>/auth/callback#code=<one-time code>`; `409 OAUTH_ACCOUNT_EXISTS` (problem+json) when another account holds the email; `RATE_LIMIT_AUTH`                                       |
| GET    | `/api/auth/github`          | public                                           | As `/api/auth/google`, for GitHub consent                                                                                                                                                                                                                                           |
| GET    | `/api/auth/github/callback` | public                                           | As the Google callback; `RATE_LIMIT_AUTH`                                                                                                                                                                                                                                           |
| POST   | `/api/auth/oauth/exchange`  | public                                           | `{ code, verifier }` → `{ accessToken }` and the refresh cookie; each code works once, for 60 s, and the first attempt spends it whether or not the verifier matches (`401 OAUTH_CODE_INVALID`); `RATE_LIMIT_AUTH`                                                                  |
| GET    | `/api/users/roles`          | JWT, admin                                       | Map of user id → roles                                                                                                                                                                                                                                                              |
| PATCH  | `/api/users/:id/roles`      | JWT, admin                                       | Replace a user's roles                                                                                                                                                                                                                                                              |
| POST   | `/api/users/:id/avatar`     | JWT, owner or admin                              | `multipart/form-data` field `file`, max 5 MB; the type comes from the leading bytes, never the client's mimetype or name: PNG, JPEG, GIF or WebP, no SVG (it can carry script); target must be a member of the caller's tenant; returns `{ url, objectName }`, a 1 h pre-signed URL |
| GET    | `/api/users/:id/avatar-url` | JWT, owner or admin                              | `?key=avatars/<id>/<file>`; fresh 1 h pre-signed URL. Avatar URLs serve the object with `Content-Disposition: attachment`, so opened directly it downloads instead of rendering                                                                                                     |
| GET    | `/api/workflows/onboarding` | JWT, admin (OPA `user:list`)                     | Onboarding workflow summary + recent executions of the caller's tenant                                                                                                                                                                                                              |
| POST   | `/api/v1/track`             | public                                           | `202 { accepted }`; batch of up to 100 events; 600 req/min per IP                                                                                                                                                                                                                   |
| POST   | `/api/v1/track/secure`      | [signed](#request-signing-server-to-server-rest) | Same as `/api/v1/track`, HMAC-signed                                                                                                                                                                                                                                                |

### Session cookie

The refresh token never reaches page script. Login, refresh and the OAuth exchange set it as the cookie `tropis_rt`: `HttpOnly`, `SameSite=Strict`, `Path=/api/auth`, 7 days, and `Secure` unless `NODE_ENV` is `development` or `test` (`COOKIE_SECURE` overrides either way; `modules/auth/cookies/refresh-cookie.ts`). Response bodies carry the access token only, and clients call the auth endpoints with `credentials: 'include'`. The endpoints that act on the cookie (refresh, logout) are CSRF-checked by `CookieCsrfGuard`: the request must send `X-Tropis-Client: 1` (a header a cross-site form cannot send and a cross-origin script cannot send without a CORS preflight) and come from an `Origin` in the CORS allow-list, or with no `Origin`, a `Sec-Fetch-Site` of `same-origin` or `same-site`; anything else is `403 AUTH_CSRF_REJECTED`. The `auth` throttler (`RATE_LIMIT_AUTH`) applies only to the routes that declare it: login, refresh, the OAuth callbacks and the exchange.
