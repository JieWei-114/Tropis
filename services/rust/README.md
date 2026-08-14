# Rust Services

The Rust language area. This folder is a **Cargo workspace**: shared toolchain
config lives here, each subfolder is an **independently deployable service**.
What services/ is for and how languages plug in: [../README.md](../README.md).

## Layout

```
rust/
├── Cargo.toml       # workspace: member list + shared dependency versions
│                    #   ([workspace.dependencies]) + release profile (lto/strip)
├── Cargo.lock       # ONE lockfile — every Rust service resolves identical deps
├── rustfmt.toml     # shared formatting rules
└── signing/         # a service (the template — copy it to start a new one)
    ├── Cargo.toml   # inherits versions via { workspace = true }
    ├── Dockerfile   # per-service on purpose: each service builds/deploys/scales alone
    ├── build.rs     # compiles its proto contract (tonic) from /proto
    ├── src/
    │   ├── main.rs      # bootstrap only: config → tracing → serve → shutdown
    │   ├── config.rs    # typed env parsing, fail fast
    │   ├── error.rs     # DomainError + the one From<> → tonic::Status mapping
    │   ├── grpc/        # transport layer — thin handlers (≈ backend controllers/)
    │   ├── domain/      # business logic, pure, no tonic imports (≈ backend services/)
    │   └── infra/       # external clients: redis/db/brokers (≈ backend infrastructure/)
    └── tests/           # integration: boots the real server, calls it with a real client
```

Full anatomy + hard rules: [docs/project-structure.md](../../docs/project-structure.md).

## How this differs from the TS backend

|                      | `apps/backend` (TS)                              | `services/rust/*`                                                                                                               |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Deployment           | ONE unit — all modules ship together             | each folder ships alone (own Dockerfile, own scaling)                                                                           |
| Features             | live in `modules/<feature>/`                     | live in a service's `domain/` — new deployable ⇒ new folder                                                                     |
| Layering enforcement | dependency-cruiser in CI                         | **the compiler**: `domain/` is `pub(crate)`, imports no tonic; leaking a domain type across the crate boundary is a build error |
| When to use          | default for all business logic / CRUD / IO-bound | only for profiled CPU-bound hot paths — see [docs/tech-decisions.md](../../docs/tech-decisions.md) "Rust vs TypeScript"         |

## Commands (run from `services/rust/`)

```bash
cargo build --workspace                                  # build everything
cargo test  --workspace                                  # unit + integration tests
cargo fmt --check                                        # formatting (CI-enforced)
cargo clippy --workspace --all-targets -- -D warnings    # lint (CI-enforced)
cargo run -p signing                                     # run one service locally
# or from repo root:
make rust-build / make rust-test
docker compose -f infra/docker/docker-compose.yml --profile rust up -d
```

## Adding a new Rust service

1. Define the contract first: `proto/<domain>/v1/<domain>.proto` (`buf lint` must pass).
2. Copy `signing/` → `rust/<name>/` (folder = domain name, no language suffix —
   the parent folder already says it's Rust). Rename in `Cargo.toml`, fix
   `build.rs` proto path.
3. Add the member to `rust/Cargo.toml` — it inherits deps/fmt/lint/lock automatically.
4. Standard-citizen requirements (non-negotiable): `grpc.health.v1` health service,
   JSON logs to stdout, graceful SIGTERM, config via env, non-root Dockerfile.
5. Wire it: compose service under the `rust` profile, CI covers it automatically
   (`cargo * --workspace`), grpcurl example in the service README.
6. Record why it exists in `docs/tech-decisions.md` (Rust services require a
   profiled justification — see the trigger conditions there).

## Conventions

- **Naming**: folder/binary = domain name (`signing`, `thumbnail`); proto package
  (`tropis.signing.v1`) and compose/runtime names stay language-neutral — contracts
  and operations never expose the implementation language.
- **Shared code**: none yet, deliberately. When a second service duplicates
  something (config loading, tracing setup), extract `rust/common/` as a library
  crate — not before (same "promote on the second consumer" rule as the rest of
  the repo).
- **Dependencies**: add versions to `[workspace.dependencies]` in `rust/Cargo.toml`,
  reference with `{ workspace = true }` in the service — keeps every service on
  identical versions.
- **Errors**: domain returns `DomainError`; only `error.rs` knows about
  `tonic::Status`. Never construct transport errors inside `domain/`.
- **Tests**: shared cross-language behavior (e.g. the HMAC test vector, synced with
  the TS guard + SDK) must carry a sync comment naming all copies.
