# services/ — polyglot services

Code outside the pnpm toolchain, one folder per runtime, `services/<runtime>/`.
A runtime folder owns its toolchain, build, packaging and CI job, and hosts any
number of services or jobs written for it.

| Runtime            | Holds                                                                  | Build                                       |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------- |
| [`rust/`](rust/)   | Rust gRPC services, one crate per service: [`signing/`](rust/signing/) | Root Cargo workspace (`services/rust/*`)    |
| [`flink/`](flink/) | Flink jobs, one class per job in `jobs/`: `PulsarToClickHouseJob`      | One Maven project, one fat JAR for all jobs |

When to add one: **almost never — profile first.** The decision table lives in
[docs/tech-decisions.md → Rust vs TypeScript](../docs/tech-decisions.md#rust-vs-typescript).
Placement, the proto-only contract, naming and the Rust service anatomy:
[docs/project-structure.md](../docs/project-structure.md#services--polyglot-services).

## Adding a service — checklist

1. **Contract first.** Define `proto/<domain>/v1/<domain>.proto`; it must pass
   `buf lint`. The proto is the only interface the rest of the system sees.
2. **Create it in its runtime folder** following the anatomy in
   [docs/project-structure.md](../docs/project-structure.md). Rust: copy
   `rust/signing/` (the reference implementation) to `rust/<service>/` and
   rename the crate; the workspace picks it up through `services/rust/*`.
   Flink: add a job class in `flink/src/main/java/com/app/flink/jobs/` and
   submit it with `JOB=<class>`. A first service on a new runtime creates
   `services/<runtime>/` with that runtime's toolchain config inside it, or
   at the repo root when the toolchain needs a workspace root (as Cargo does).
3. **Be a standard citizen:**
   - `grpc.health.v1` health service (probed by compose/k8s),
   - JSON logs to stdout,
   - graceful shutdown on SIGTERM,
   - all config via env vars (fail fast on invalid config),
   - multi-stage Dockerfile running as a non-root user.
4. **Wire it up:** a compose profile named after the service in
   `infra/docker/docker-compose.yml`, CI job (or workspace membership for
   Rust — the `rust` job already covers all members), an `up-<profile>`
   Makefile target.
5. **Document:** add an entry to `docs/tech-decisions.md` explaining why this
   couldn't be TypeScript.

## Rust workspace

Rust services are members of the Cargo workspace rooted at the repo root
([`Cargo.toml`](../Cargo.toml), one `rustfmt.toml`, one `Cargo.lock` and
`target/`); `apps/desktop/src-tauri` is excluded and keeps its own workspace.
Run everything from the repo root:

```bash
cargo build --workspace                                  # build everything
cargo test  --workspace                                  # unit + integration tests
cargo fmt --check                                        # formatting (CI-enforced)
cargo clippy --workspace --all-targets -- -D warnings    # lint (CI-enforced)
cargo run -p signing                                     # run one service locally
make rust-build / make rust-test
docker compose -f infra/docker/docker-compose.yml --profile signing up -d
```

## Flink jobs

[`flink/`](flink/) is one Maven project; its fat JAR carries every job and runs
on the Flink cluster from the `stream` compose profile. A job is selected at
submit time with `JOB=<class in jobs/>` (default `PulsarToClickHouseJob`) and
`ARGS=<program args>` (default: that job's Pulsar and ClickHouse settings):

```bash
make up-stream                                  # Flink jobmanager + taskmanager
make -C services/flink submit                   # build the JAR, submit PulsarToClickHouseJob
make -C services/flink submit JOB=<Class> ARGS='…'  # submit another job from the same JAR
bash services/flink/submit-job.sh               # same, without local Maven (falls back to Docker)
```

`PulsarToClickHouseJob` writes `logs.analytics_events`, the table the console reads, so it
runs only when the backend has `STREAM_ENGINE=flink`; the rule is in
[docs/tech-decisions.md](../docs/tech-decisions.md#stream-processing-flink).
