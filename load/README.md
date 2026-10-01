# Load tests (k6)

Load/performance scenarios for the backend REST surface, written for
[k6](https://k6.io). Scripts live in `scenarios/`. Where load tests sit in the
test pyramid: [docs/testing.md](../docs/testing.md#load-tests).

> **Never run these against production.** They deliberately hammer the
> ingest endpoint and will pollute analytics data (events named
> `load_test_event`), trip rate limits, and skew autoscaling. Target local
> (`make up` + backend) or a dedicated staging environment only.

## Prerequisites

The stack must be up and the backend healthy:

```bash
make up                       # the containers the backend needs
make dev                      # or: pnpm --filter @tropis/backend start
curl http://localhost:3100/api/health   # must return 200
make seed                     # login.js needs the seeded admin@example.com user
```

## Running

All three, in Docker: `make load-test`. It checks `/api/health` first, then
runs each scenario in a `grafana/k6` container against
`http://host.docker.internal:3100` (`--add-host=host.docker.internal:host-gateway`),
because inside a container `localhost` is the container itself on Docker
Desktop. One scenario the same way:

```bash
docker run --rm -i --add-host=host.docker.internal:host-gateway \
  -e OPS_URL=http://host.docker.internal:9464 grafana/k6 run - < load/scenarios/health.js
```

Or with a local k6 binary (`brew install k6`), which reaches `localhost`
directly:

```bash
k6 run load/scenarios/health.js
```

### Options (env vars, `-e KEY=VAL` for docker / `k6 run -e KEY=VAL`)

| Var                              | Default                                                  | Used by                   |
| -------------------------------- | -------------------------------------------------------- | ------------------------- |
| `BASE_URL`                       | `http://localhost:3100`                                  | login.js, track-ingest.js |
| `OPS_URL`                        | `http://localhost:9464`                                  | health.js                 |
| `LOGIN_EMAIL` / `LOGIN_PASSWORD` | `admin@example.com` / `Password123!` (seed defaults)     | login.js                  |
| `BATCH_SIZE`                     | `20` (API max 100)                                       | track-ingest.js           |
| `TENANT_ID`                      | `dev` (the seeded tenant; must be registered and active) | login.js, track-ingest.js |

## Scenarios

| Script            | Endpoint                                    | Shape                                       | Thresholds                                            |
| ----------------- | ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| `health.js`       | `GET :9464/readyz`                          | 0→5→0 VUs over 60s                          | p95 < 200ms, errors < 1%                              |
| `track-ingest.js` | `POST /api/v1/track` (public batch ingest)  | 0→50→0 VUs over ~105s                       | p95 < 200ms, > 99% of non-throttled requests accepted |
| `login.js`        | `POST /api/auth/login` + `GET /api/auth/me` | 0→3→0 VUs (endpoint is throttled 10/min/IP) | p95 < 500ms, errors < 1%                              |

## What the thresholds mean

- `http_req_duration: p(95)<200` — 95% of requests must complete in under
  200ms. Health and track are fast paths (track responds 202 before doing any
  work); login is allowed 500ms because bcrypt verification is intentionally
  slow.
- `http_req_failed: rate<0.01` (`health.js`, `login.js`) — fewer than 1% of
  requests may fail (network errors or unexpected HTTP statuses). In
  `login.js`, 429s from the rate limiter are _expected_ responses, tracked in
  a separate `login_throttled` metric instead of counting as failures.
- `checks{kind:accepted}: rate>0.99` (`track-ingest.js`) — the beacon endpoint
  is limited to 600 requests/min per IP and 50 VUs exceed that on purpose, so
  429s are tracked in `throttled_requests` and only the other responses must
  be accepted.

If any threshold is crossed, k6 marks it with a ✗ and **exits non-zero**,
which is what makes these usable as a CI gate.

## Interpreting the output

At the end of a run k6 prints a summary block:

- `http_req_duration` — the latency line that matters. Look at `p(90)`/`p(95)`,
  not `avg` (averages hide tail latency).
- `http_req_failed` — failure rate; should be ~0%.
- `checks` — pass rate of the `check()` assertions in the script (e.g.
  "status is 202", "accepted full batch"). Failing checks with passing
  thresholds usually means wrong responses, not slow ones.
- `iterations` / `http_reqs` — achieved throughput. For track-ingest, multiply
  `http_reqs` by `BATCH_SIZE` for events/run.
- `vus_max` — confirm the ramp actually reached the target VU count.
- `dropped_iterations` (if shown) — the system under test couldn't keep up.

A ✓ next to a threshold means it held for the whole run; ✗ means it was
breached (and the exit code is non-zero).
