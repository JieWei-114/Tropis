# devtools — local CLI tools that poke the running stack

Local-only developer tools that connect to the **running** system. Like `e2e/`
and `load/`, this is a top-level workspace package, not part of any app, so no
app ships dev-only code. Web UIs (grpcui, mongo-express, RedisInsight, …) live
in the compose `tools` profile instead. Every tool and how to run it is listed
in [docs/development.md](../docs/development.md#dev-tools).

`src/lib/rpc.ts` is the shared helper (health check, login through the
`@tropis/sdk` Connect clients, tenant from `TENANT_ID`, `dev` when unset). It
is devtools' own copy; the backend seeder keeps its own minimal variant in
`apps/backend/scripts/lib/rpc.ts`.

## Adding a new tool

1. Add one `.ts` file in `src/` (one file per tool; reuse `src/lib/`).
2. Add a package script (`"my-tool": "tsx src/my-tool.ts"`).
3. Add a make target that runs `pnpm --filter @tropis/devtools my-tool`, with
   the "is the stack up?" guard the existing targets use.
4. Add a row to the Dev tools table in `docs/development.md`.

## Rules

- **Apps never import devtools** — the dependency is one-way, so apps ship no
  dev-only code.
- Tools reach apps only through their **public surfaces** (RPC, REST,
  WebSocket, MongoDB), never TypeScript imports into an app's `src/`, so an
  app can change its internals without breaking a tool. `@tropis/sdk` is
  allowed because it is a published client.
- Sharing config by reading files (`outbox-status` and `outbox-dead` read
  `apps/backend/.env`) is fine; sharing code is not.
