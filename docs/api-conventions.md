# API Conventions

API tier separation, request signing, and cryptography terminology. Complements [api-versioning.md](api-versioning.md) (compatibility rules) and [architecture.md](architecture.md) (transport strategy).

## Tiers

Every API surface belongs to exactly one of two tiers.

|                | **Public tier**                                                   | **Internal tier**                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces       | REST `/api/v1/*` + gRPC `tropis.<domain>.v1` (gRPC-Web via Envoy) | gRPC `tropis.<domain>.internal.v1` only                                                                                                                                                                                             |
| Reached via    | Envoy (browser gRPC-Web) / ingress (REST) — gRPC port **50051**   | Dedicated gRPC port **50061** (`GRPC_INTERNAL_PORT`), `backend-internal-svc:50061` inside the cluster — **never** routed through Envoy                                                                                              |
| Network        | Internet-facing                                                   | Port-separated listener: ClusterIP-only Service + NetworkPolicy (namespace-only ingress on 50061). The internal proto package is loaded **only** on the :50061 listener, so internal RPCs are unreachable on :50051 by construction |
| Auth — users   | JWT bearer token (`modules/auth`)                                 | n/a                                                                                                                                                                                                                                 |
| Auth — servers | API Key + HMAC request signature (below)                          | Service identity: `x-service-token` metadata (template) → mTLS/SPIFFE (production)                                                                                                                                                  |
| Proto layout   | `proto/<domain>/v1/<domain>.proto`                                | `proto/<domain>/internal/v1/<domain>_internal.proto`                                                                                                                                                                                |
| SDK            | Generated into `packages/sdk/src/gen/`                            | **Excluded** from SDK codegen (`buf.gen.yaml` `exclude_paths`); internal clients generate their own types from the proto                                                                                                            |

**Zero-trust rule:** internal calls still authenticate — the separate port does not change this. Port separation (50061 ClusterIP-only + NetworkPolicy) decides _exposure_; the `x-service-token` check decides _identity_. "It's inside the cluster" (or "it arrived on the internal port") is a network posture, not an identity — an internal RPC without a valid service identity is rejected (`PERMISSION_DENIED`). The template check is a constant-time compare of `x-service-token` metadata against `SERVICE_TOKEN` (unset ⇒ internal tier disabled, RPCs return `UNIMPLEMENTED`); production deployments should replace the shared token with transport-level identity (mTLS / SPIFFE via a service mesh).

**Which tier does my RPC go in?**

- Called by a browser, mobile app, or third-party server → **public** (`tropis.<domain>.v1` / `/api/v1/*`).
- Called only by our own services (trusted lookups, bulk/admin operations, data that must never cross the trust boundary, e.g. `GetUserByEmail` without a user JWT) → **internal** (`tropis.<domain>.internal.v1`).
- If in doubt, start internal — promoting to public later is add-only; retracting a public RPC is a breaking change.

Live example: `tropis.user.internal.v1.UserInternalService.GetUserByEmail` (`proto/user/internal/v1/user_internal.proto`, handler in `modules/user/controllers/user-internal.grpc.controller.ts`).

## Crypto terminology — use the right word

| Term                  | Purpose                                                              | Algorithms here                                                                                      | It is NOT                                                    |
| --------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **encode / decode**   | Formatting so data survives a transport (base64, URL-encoding, hex)  | base64, percent-encoding                                                                             | Security. Anyone can decode. Never call base64 "encryption". |
| **encrypt / decrypt** | Confidentiality — only key holders can read                          | AES-256-GCM via **Vault Transit** (`VaultService.encrypt/decrypt`, `src/infrastructure/vault/`)      | Integrity or identity by itself                              |
| **sign / verify**     | Integrity + identity — proves who sent it and that it wasn't altered | HMAC-SHA256 (API requests, webhooks), Ed25519/RS256 where asymmetry is needed (JWT uses HS256 today) | Confidentiality. Signed data is still readable.              |
| **hash**              | One-way fingerprint                                                  | SHA-256 (canonical body hash), bcrypt (passwords)                                                    | Reversible; not encryption                                   |

Rules:

1. **TLS is the mandatory baseline** for every hop (ingress, Envoy, service-to-service). Field-level crypto is _in addition to_, never instead of, TLS.
2. **Field-level encryption of PII goes through Vault Transit** — see `UserService.encryptEmail/decryptEmail` (user emails at rest) using `VaultService.encrypt(keyName, plaintext)` / `decrypt(...)`. Keys live in Vault, ciphertext is `vault:v1:...`, and key rotation is a Vault operation, not a code change.
3. **Never invent crypto.** No hand-rolled ciphers, no custom token formats, no "XOR obfuscation". Use Vault Transit, `node:crypto`, or WebCrypto primitives exactly as specified here.

## Request signing (server-to-server REST)

Authenticates machine callers on public REST endpoints marked `@RequireSignature()` (guard: `common/guards/signature.guard.ts`; client: `@tropis/sdk` → `signRequest` / `createSignedFetch`).

### Headers

| Header        | Value                                 |
| ------------- | ------------------------------------- |
| `X-Api-Key`   | Key id (identifies the caller)        |
| `X-Timestamp` | Unix **seconds** at signing time      |
| `X-Nonce`     | UUID, unique per request              |
| `X-Signature` | `hex(HMAC-SHA256(secret, canonical))` |

### Canonical string

```
METHOD                \n   # uppercased, e.g. POST
PATH                  \n   # full path incl. /api prefix + query string, e.g. /api/v1/track/secure
X-Timestamp value     \n
X-Nonce value         \n
SHA256(body) as lowercase hex   # hash of the EXACT raw bytes sent; '' body hashes too
```

The signature covers the raw request bytes — `main.ts` configures `express.json({ verify })` to capture them on `req.rawBody`; do not sign a re-serialized `JSON.parse` round-trip.

### Server validation (in order)

1. All four headers present, else `401 SIGNATURE_INVALID`.
2. `|now − X-Timestamp| ≤ 300 s`, else `401 SIGNATURE_EXPIRED`.
3. Key id resolves to a secret (`ApiKeyService`), else `401 API_KEY_UNKNOWN`. Template storage: `API_KEYS` env var, JSON map `{keyId: secret}` — works with plain `.env` or via Vault KV (merged into `process.env` at bootstrap). Production: one Vault KV entry per key so keys rotate/revoke individually.
4. Nonce dedup: Redis `SET sig:nonce:<keyId>:<nonce> 1 EX 300 NX` — a reused nonce inside the window is `401 NONCE_REUSED`.
5. Recompute the signature and compare **constant-time** (`crypto.timingSafeEqual`), else `401 SIGNATURE_INVALID`.

All four error codes live in `packages/shared/src/errors/error-codes.ts`.

**Outgoing webhooks use the same scheme**: we sign the webhook body with the receiver's secret and send the same four headers, so receivers validate exactly as above. One spec, both directions.

Shared test vector: the backend guard spec (`common/guards/__tests__/signature.guard.spec.ts`) and the SDK signing test (`packages/sdk/src/signing/__tests__/signing.test.ts`) pin the same canonical string → signature pair; changing the scheme must update both.

## Response envelope

Successful REST responses are wrapped by `common/interceptors/transform.interceptor.ts`:

```json
{ "success": true, "data": { ... }, "timestamp": "2026-01-01T00:00:00.000Z" }
```

Errors are shaped by `common/filters/http-exception.filter.ts` (`GlobalExceptionFilter`):

```json
{
  "success": false,
  "code": "SIGNATURE_EXPIRED",
  "message": "X-Timestamp outside the ±300s window",
  "traceId": "…",
  "path": "/api/v1/track/secure",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "errors": ["optional field-level validation messages"]
}
```

Notes:

- `code` appears **only on errors** and is always a value from the single source of truth, `packages/shared/src/errors/error-codes.ts` (`ERROR_CODES`). Never invent ad-hoc code strings — add to the table.
- `traceId` echoes the `X-Trace-Id` request header or is generated. Success responses currently don't carry `traceId`/`code`/`message`; the type contract is `ApiResponse<T>` in `packages/shared/src/types/api-response.types.ts`.
- gRPC errors map through `common/filters/grpc-exception.filter.ts` using the same error-code table (`HTTP_STATUS_TO_GRPC_STATUS`).

## Parameter & data conventions

- **JSON bodies / query params: `camelCase`** (`eventName`, `anonymousId`).
- **Proto fields: `snake_case`** (`login_count`, `idempotency_key`) — buf enforces it; the gRPC loader uses `keepCase: true` so handlers see snake_case as-is; transformers map at the boundary.
- **Timestamps:** JSON = ISO 8601 UTC strings (`2026-01-01T00:00:00.000Z` — the envelope's `timestamp`); proto = `int64` epoch **milliseconds** (the live convention: `tracking.proto` `timestamp = 8; // epoch ms`, `analytics.proto` `cached_at`). `X-Timestamp` in request signing is the one deliberate exception: unix **seconds**, per the spec above.
- **Money: integer minor units** (cents/sen) in an `int64`/`number`, plus an explicit currency code. **Never floats** — `0.1 + 0.2 !== 0.3`.
- **Pagination:** requests take `page` (1-based) + `limit` — shared `PaginationDto` / `PaginationQuery` in `packages/shared/src/dto/pagination.dto.ts`; list responses use `PaginatedResult<T>` (`data`, `total`, `page`, `limit`, `totalPages`).
- **IDs:** opaque strings; never expose Mongo `_id`/`__v` (transformers strip them).
