# devtools — local CLI tools that poke the running stack

Local-only developer tools that connect to the **running** system (like `e2e/`
and `load/`, this is a top-level workspace package, not part of any app).
Web UIs (grpcui, mongo-express, RedisInsight, …) live in the compose `tools`
profile (`make up-tools`); custom CLI tools and scripts live here. The full
technology → tool map is in [docs/dev-tools.md](../docs/dev-tools.md).

## Tools

| Tool                   | What it does                                                                                      | Run                  |
| ---------------------- | ------------------------------------------------------------------------------------------------- | -------------------- |
| `src/ws-listen.ts`     | Prints every Socket.io `/ws` event live (auto-logs-in as the seeded admin, or pass `TOKEN=<jwt>`) | `make ws-listen`     |
| `src/outbox-status.ts` | Outbox snapshot straight from MongoDB: counts by status + oldest pending/failed rows              | `make outbox-status` |
| `src/sdk-repl.ts`      | Node REPL with the `@tropis/sdk` facade preloaded + logged in (`await api.fetchUsers()`)          | `make sdk-repl`      |

**Local Kubernetes views** (the `kind-tropis` cluster — see [deployment.md](../docs/deployment.md)):
`make k8s` opens **k9s** (terminal UI) and `make k8s-ui` opens **Headlamp**
(browser/desktop UI). Both auto-install via brew; they're external tools driven
by a make target, not `.ts` scripts.

`src/lib/grpc.ts` is the shared helper (health check, proto loading, unary
calls, gRPC login). It is devtools' own copy — the backend seeder keeps its
own minimal variant in `apps/backend/scripts/lib/grpc.ts`.

## Adding a new tool

1. Drop a `.ts` file in `src/` (one file per tool; reuse `src/lib/`).
2. Add a package script here (`"my-tool": "tsx src/my-tool.ts"`).
3. Add a make target that runs `pnpm --filter @tropis/devtools my-tool`
   (keep the "is the stack up?" guard pattern the existing targets use).
4. Add a one-line row to the table above and to `docs/dev-tools.md`.

## Rules

- **Devtools is never imported by apps** — the dependency is strictly one-way.
- Tools talk to apps only through their **public surfaces**: gRPC, HTTP/REST,
  WebSocket, MongoDB — never TypeScript imports into apps' `src/`.
  `@tropis/sdk` is allowed since it's a published client.
- Config sharing by reading files (e.g. `outbox-status` reads
  `apps/backend/.env`) is fine; code sharing is not.
