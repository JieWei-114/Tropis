# services/ — polyglot services

Language-autonomous deployable services. `apps/` is the TypeScript family
sharing the pnpm toolchain; **`services/` is everything else** — one folder
per **language** (`services/rust/`, a future `services/go/`), and inside it
one folder per service, each with its own Dockerfile, README, and tests. The
language folder holds the shared toolchain config (for Rust: the Cargo
workspace root); the service folders inside are independently deployable
services, **not** modules of one app.
Nothing here is a pnpm workspace package, and nothing imports across the
language boundary.

When to add one: **almost never — profile first.** The decision table lives in
[docs/tech-decisions.md → Rust vs TypeScript](../docs/tech-decisions.md#rust-vs-typescript).

## Why this works

Contracts don't live in any language's package manager — they live in
[`/proto`](../proto/) as language-neutral protobuf, governed by buf
(`buf lint` on every PR, `buf breaking` gates contract changes in CI).
Synchronous calls go over gRPC; events go over Pulsar. So any language that
speaks gRPC/protobuf plugs into the system with **zero changes to existing
code**: the TS SDK generates its client from the same proto the Rust
`build.rs` compiles.

| Concept     | Meaning                                                                                                    | Example                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Service** | A deployable unit: own folder here, own Dockerfile, own compose entry, independently built/deployed/scaled | `services/rust/signing/`                                                                              |
| **Feature** | A module INSIDE a service's `domain/` — never its own deployable                                           | signature verification is a _feature_ of the signing service (`rust/signing/src/domain/signature.rs`) |

Don't spin up a new service for a new feature of an existing domain — add a
`domain/<feature>.rs` module instead.

## Adding a service — checklist

1. **Contract first.** Define `proto/<domain>/v1/<domain>.proto`; it must pass
   `buf lint`. The proto is the only interface the rest of the system sees.
2. **Create `services/<lang>/<name>/`** following the language anatomy in
   [docs/project-structure.md](../docs/project-structure.md). For Rust: copy
   `rust/signing/` (the reference implementation) and add the folder to
   `members` in [`services/rust/Cargo.toml`](rust/Cargo.toml). A first service
   in a new language creates the language folder with its toolchain config
   (e.g. `services/go/` with a `go.work`).
3. **Be a standard citizen:**
   - `grpc.health.v1` health service (probed by compose/k8s),
   - JSON logs to stdout,
   - graceful shutdown on SIGTERM,
   - all config via env vars (fail fast on invalid config),
   - multi-stage Dockerfile running as a non-root user.
4. **Wire it up:** compose profile in `infra/docker/docker-compose.yml`, CI
   job (or workspace membership for Rust — the `rust` job already covers all
   members), Makefile target.
5. **Document:** add an entry to `docs/tech-decisions.md` explaining why this
   couldn't be TypeScript.

## Naming

- Folder: `services/<lang>/<name>` (`services/rust/signing`; a Go port would
  be `services/go/signing`). The service folder is the plain domain name — no
  language suffix, the parent language folder already carries it.
- Everything else stays **language-neutral**: proto package (`tropis.signing.v1`),
  binary/crate (`signing`), compose service (`signing`). Reimplementing a
  service in another language changes no contracts or deployment names.

## Rust workspace

Details, commands, conventions, and the add-a-service walkthrough:
[rust/README.md](rust/README.md).

Rust services are members of the Cargo workspace rooted at `services/rust/`:

- `services/rust/Cargo.toml` — members list, shared dependency versions
  (`[workspace.dependencies]`), shared `edition`/`license`, and the release
  profile. Members inherit with `{ workspace = true }`.
- `services/rust/rustfmt.toml` — one formatting config for all members.
- Single `services/rust/Cargo.lock` and `services/rust/target/` — run
  `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  and `cargo test --workspace` from `services/rust/` (CI and `make rust-test` do).
- **Dockerfiles stay per-service** (in each service folder): a service is the
  deployable unit and must build, deploy, and scale independently. Each
  Dockerfile copies the workspace manifests for the dependency-cache layer and
  builds only its own crate (`cargo build --release -p <crate>`), with the
  repo root as build context (it needs `proto/`).

### When to extract `services/rust/common`

There is deliberately **no shared library crate yet** — no second consumer
exists. The three-tier placement rule (docs/project-structure.md) applies
here too: keep code inside the one service that uses it, and promote it to a
`services/rust/common` workspace member only when a **second real** Rust service
needs the same code. Never "just in case".
