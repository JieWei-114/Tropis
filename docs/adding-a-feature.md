# Adding a Feature — Step by Step

Walkthrough for creating a new backend module following the standard anatomy in `docs/project-structure.md`. The **`modules/user/` module is the closest live example** — read it alongside this guide (it follows the full folder anatomy, plus extra CQRS folders).

Example feature: `order`.

## 1. Define the proto (v1)

Create `proto/order/v1/order.proto`:

```proto
syntax = "proto3";
package tropis.order.v1;

service OrderService {
  rpc Create (CreateOrderRequest) returns (OrderResponse);
  rpc FindById (FindOrderRequest) returns (OrderResponse);
}

message CreateOrderRequest {
  string user_id = 1;
  int64 amount_cents = 2;   // money = integers, stored in PostgreSQL
}
```

Add-only rules apply from day one (`docs/api-versioning.md`). Run `buf lint` / `buf breaking` locally.

## 2. Generate types

Add the proto path to the gRPC server options in `main.ts` (see how the existing `proto/<domain>/v1/*.proto` files are loaded via `@grpc/proto-loader`; server plumbing lives in `src/infrastructure/grpc/`). Run `make proto` (buf) to regenerate the SDK types in `packages/sdk/src/gen/`, and declare the backend TS interfaces for requests/responses.

## 3. Create the module skeleton

```
modules/order/
├── order.module.ts
├── controllers/  services/  repositories/  schemas/  processors/
├── dto/  transformers/  interfaces/  constants/  utils/  __tests__/
```

## 4. Schema — `schemas/order.schema.ts`

Mongoose schema or TypeORM entity (orders are money → TypeORM entity on PostgreSQL). Never returned from an API directly.

## 5. Repository — `repositories/order.repository.ts`

The only file that touches the ORM. Expose intent-named methods (`findById`, `createWithOutbox`), not query builders.

## 6. Service — `services/order.service.ts`

All business logic. Injects the repository, `OutboxService`, queue service — never drivers. On state change, write the domain row **and the outbox entry in the same transaction** (see `modules/user/` create flow + `src/infrastructure/outbox/outbox.service.ts`).

## 7. Controllers — `controllers/`

- `order.grpc.controller.ts` — implements `tropis.order.v1.OrderService`. Thin: validate → service → transformer.
- REST controller **only if** the feature hits a REST-only case (upload / OAuth callback / webhook — see `docs/architecture.md`). Otherwise skip it.

## 8. Transformer — `transformers/order.transformer.ts`

Entity → proto/DTO mapping; strips internal fields. Compare `modules/user/transformers/user.transformer.ts`.

## 9. Constants — `constants/order.constants.ts`

Queue names, cache key prefixes, error codes, event names. No magic strings anywhere else.

## 10. Domain events — `packages/shared`

Register the event types in `packages/shared/src/events/app-event.ts`:

```ts
export const EVENT_TYPES = {
  // ...
  ORDER_CREATED: 'order.created',
} as const;
```

Rebuild shared: `pnpm --filter @tropis/shared build` (Flink consumers follow the same contract).

## 11. Outbox publish

In the service, after the domain write, insert an outbox document with `eventType: EVENT_TYPES.ORDER_CREATED` and a JSON payload. The relay (`src/infrastructure/outbox/outbox.relay.ts`) publishes it via the `MESSAGE_BROKER` port — you don't touch Pulsar.

> Exception: **lossy-tolerant telemetry** (e.g. `modules/tracking/` user-behavior events) may publish to Pulsar directly — see the Tracking section of `docs/tech-decisions.md`. Domain events always go through the outbox.

## 12. Processor / subscriber — `processors/`

- BullMQ worker for background work (`@Processor(...)`, queue name from `constants/`; see `src/infrastructure/queue/notification.processor.ts`).
- Pulsar/EventBus subscriber if this module reacts to other modules' events. Thin — delegate to the service. Dedup replays with Redis `SET NX` (see `modules/user/processors/`).

## 13. Tests

- Unit: `__tests__/order.service.spec.ts` with mocked repository (pattern: `modules/user/__tests__/user.service.spec.ts`). 80%+ on services/utils.
- Integration: `apps/backend/test/integration/order.integration.spec.ts` with Testcontainers (`pnpm --filter @tropis/backend test:int` / `make test-int`).
- Bug fixes later: repro test first.

## 14. Wire it up

Add `OrderModule` to `apps/backend/src/app.module.ts` imports; register the gRPC service name in the server's service list; add health/metrics only if the module brings a new external dependency (then it also gets an indicator in `src/modules/health/indicators/`).

## Checklist

- [ ] proto in `proto/order/v1/`, buf passes
- [ ] one-way layering respected (controller → service → repository → schema)
- [ ] transformer on every outbound shape
- [ ] constants file, no magic strings
- [ ] event type in `packages/shared`, published via outbox
- [ ] unit + integration tests, coverage on services/utils
- [ ] module imported in `app.module.ts`
- [ ] `.env.example` + Joi schema updated if new config
