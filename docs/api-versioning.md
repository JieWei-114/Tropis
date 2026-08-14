# API Versioning

Applies to gRPC (primary), REST (the gap-filler), and event payloads.

## gRPC / Protobuf

### Layout

```
proto/
└── <domain>/
    └── v1/
        └── <domain>.proto     # package tropis.<domain>.v1;
```

Example: `proto/user/v1/user.proto` declares `package tropis.user.v1;`.

This is the live layout: `auth`, `user`, `analytics`, `tracking`, `signing`, and `health` each have a `<domain>/v1/<domain>.proto` with a `tropis.<domain>.v1` package. SDK types are generated from them via buf (`make proto` → `packages/sdk/src/gen/`).

### Compatibility rules (within a version)

1. **Only add fields.** Never remove, never change type/meaning of an existing field.
2. **Never reuse field numbers.** Removed field? `reserved 5;` forever.
3. **Never rename in a breaking way** — wire format uses numbers, but generated code breaks callers; treat renames as breaking.
4. **Semantic change ⇒ new version.** If field 3 used to mean cents and now means dollars, that's `tropis.<domain>.v2`, not a doc comment.

### Enforcement

`buf breaking --against '.git#branch=main'` runs in CI. A PR that breaks wire compatibility fails.

## REST

- All versioned business routes are prefixed `/api/v1` — the global prefix is `api` (`app.setGlobalPrefix('api')` in `main.ts`) and the version segment lives in the controller path (e.g. `@Controller('v1/track')`). Infrastructure endpoints (`/api/health`, `/api/metrics`, OAuth callbacks) stay unversioned.

- Same add-only rules as proto: new optional fields OK; removing/renaming/retyping a field ⇒ `/api/v2`.

## v1/v2 coexistence

When a breaking change is unavoidable:

1. **Parallel controllers, shared services.** `UserV2Controller` (`@Controller({ version: '2' })`) and the v2 proto handler sit next to v1 — both call the _same_ service layer; only DTOs/transformers differ.
2. **Deprecate loudly**:
   - REST v1 responses gain `Deprecation: true` and `Sunset: <RFC 1123 date>` headers.
   - gRPC v1 methods get `option deprecated = true;` in the proto.
   - SDK/shared types get `@deprecated` JSDoc with the replacement named.
3. **Migration window**: announce a sunset date, monitor v1 traffic (Prometheus per-route metrics), and **never delete v1 until traffic is zero or the window has closed** — whichever is later.

| Change                 | Action                                  |
| ---------------------- | --------------------------------------- |
| Add optional field     | Allowed in v1                           |
| Add new RPC/endpoint   | Allowed in v1                           |
| Remove/rename field    | v2 package + coexistence                |
| Change field semantics | v2 package + coexistence                |
| Delete v1              | Only after sunset window + zero traffic |

## Event payloads

`AppEvent` payloads (`packages/shared/src/events/app-event.ts`) follow the **same add-only rule**: producers may add fields; consumers (Flink, future services) MUST ignore unknown fields and MUST NOT require new fields from old events still sitting in Pulsar backlog or the event store. Breaking payload change ⇒ new event type (e.g. `user.created.v2` in `EVENT_TYPES`).

## Distributing contracts

Three consumption tiers, from closest to farthest:

### (a) Same repo — workspace `@tropis/sdk` (current)

Apps in this monorepo depend on the SDK via pnpm workspaces:

```jsonc
"dependencies": { "@tropis/sdk": "workspace:*" }
```

They consume TypeScript source directly (`packages/sdk/src/index.ts` via the
package's `exports` map) — no build step, Vite/tsc handle it. Regenerate types
after proto changes with `make proto`.

### (b) Other repos, same org — publish `@tropis/sdk` to npm

For JS/TS consumers outside this repo, publish the built SDK to a private
registry (npm org or GitHub Packages):

```bash
pnpm --filter @tropis/sdk build      # tsup → packages/sdk/dist (ESM + .d.ts)
cd packages/sdk && pnpm publish   # publishConfig swaps exports to dist/ at publish time
```

To enable: remove `"private": true` from `packages/sdk/package.json`, set its
`"version"` to the current repo release (release-please manages the root
`package.json` version — mirror it manually, or adopt a release-please
manifest config for per-package versions later), and add the `NPM_TOKEN`
secret to use the dormant `.github/workflows/publish.yml`
(`workflow_dispatch`). SDK version = repo release version.

### (c) Polyglot / multi-team — push protos to the Buf Schema Registry

Non-TS consumers (Go, Java, Python, other orgs' toolchains) shouldn't consume
our generated code — they should generate their own from the proto module:

```bash
# One-time: replace the placeholder in buf.yaml
#   modules:
#     - path: proto
#       name: buf.build/tropis/tropis   # ← put your real BSR org here
buf registry login          # or set BUF_TOKEN
buf push                    # publishes the module to the BSR
```

Consumers then depend on `buf.build/tropis/tropis` in their own `buf.yaml`
`deps` and run `buf generate` with whatever plugins their language needs. The
same dormant `publish.yml` workflow runs `buf push` in CI once the `BUF_TOKEN`
secret exists. Note the internal tier (`proto/user/internal/**`) is part of the
module — if it must stay org-private, keep the BSR repository private.
