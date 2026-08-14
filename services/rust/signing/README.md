# signing (Rust gRPC service)

`tropis.signing.v1.SigningService` — computes and verifies the HMAC-SHA256
request signatures specified in [docs/api-conventions.md](../../../docs/api-conventions.md)
(§ Request signing). Why it exists as a polyglot service, and why in Rust:
[services/README.md](../README.md) and
[docs/tech-decisions.md → Rust vs TypeScript](../../../docs/tech-decisions.md#rust-vs-typescript).

## What it does

- `ComputeSignature` — canonical string `METHOD \n PATH \n timestamp \n nonce \n sha256(body)` → `hex(HMAC-SHA256(secret, canonical))`.
- `VerifySignature` — timestamp window ±300 s, key lookup, constant-time compare (`subtle`). Returns `valid` + `reason` (`OK | SIGNATURE_EXPIRED | API_KEY_UNKNOWN | SIGNATURE_INVALID`).

Byte-for-byte compatible with the TypeScript implementations — the shared
test vector in `src/domain/signature.rs` is pinned in sync with
`apps/backend/src/common/guards/__tests__/signature.guard.spec.ts` and
`packages/sdk/src/signing/__tests__/signing.test.ts`.

**Deliberately NOT here:** nonce replay dedup (Redis `SET NX EX 300`) —
that stays with the gateway/backend caller. This service is pure
computation, so it is stateless and horizontally scalable.

## Layout

Reference implementation of the **Rust service anatomy** — see
[docs/project-structure.md → "Rust service anatomy"](../../../docs/project-structure.md)
for the layout and the compiler-enforced `grpc/ → domain/ → infra/` one-way
rule. The crate is a member of the Cargo workspace at
[`services/rust/Cargo.toml`](../Cargo.toml) (shared deps, rustfmt, lockfile).

## Configuration

| Env var     | Default | Meaning                                                 |
| ----------- | ------- | ------------------------------------------------------- |
| `API_KEYS`  | `{}`    | JSON map `{keyId: secret}` — same format as the backend |
| `GRPC_PORT` | `50052` | Listen port                                             |
| `RUST_LOG`  | `info`  | Log filter (JSON logs to stdout)                        |

## Run

```bash
# Local (needs protoc: brew install protobuf / apt install protobuf-compiler)
API_KEYS='{"svc-test":"test-secret-material-for-hmac-vector"}' cargo run -p signing

# Docker (context = repo root, it needs proto/ and the workspace manifests)
docker build -f services/rust/signing/Dockerfile -t signing .
docker run -e API_KEYS='{"svc-test":"secret"}' -p 50052:50052 signing

# Compose (rust profile)
docker compose -f infra/docker/docker-compose.yml --profile rust up -d signing
```

## Call it

```bash
grpcurl -plaintext -import-path proto -proto signing/v1/signing.proto \
  -d '{"method":"POST","path":"/api/v1/track/secure","timestamp":"1700000000",
       "nonce":"7f9c24e5-1c4b-4c8a-9d3e-2f6a8b1c0d5e",
       "body":"eyJldmVudHMiOlt7ImV2ZW50TmFtZSI6ImJ1dHRvbl9jbGljayJ9XX0=",
       "keyId":"svc-test"}' \
  localhost:50052 tropis.signing.v1.SigningService/ComputeSignature

# Health (standard grpc.health.v1, probed by compose/k8s). The server does
# not expose reflection, so use grpc-health-probe (or grpcurl with the
# upstream grpc-proto health.proto):
grpc-health-probe -addr localhost:50052
```

## Contract compatibility

The proto in `proto/signing/v1/signing.proto` is the single source of truth.
`buf lint` / `buf breaking` gate changes in CI; `make proto` regenerates the
TypeScript SDK types (`packages/sdk/src/gen/signing/`), and `build.rs`
recompiles the same file into Rust at build time — both sides always derive
from the identical contract.

## Develop

Run from the workspace root `services/rust/`:

```bash
cargo test --workspace           # includes the shared-vector parity test
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
```
