// Load-shedding behaviour of the beacon endpoint — POST /api/v1/track
// (apps/backend/src/modules/tracking/controllers/tracking.controller.ts).
//
// WHAT THIS MEASURES. The route is rate limited to 600 req/min per IP, and a
// single k6 host is one IP, so 50 VUs sit far above the limit by design. What
// the run proves is therefore: under heavy overload the endpoint keeps
// answering fast (p95 well under 200ms) and sheds the excess as 429 instead of
// queueing, timing out or falling over — it does NOT measure peak ingest
// throughput. Expect ~99% throttled; the accepted share is the limiter's
// allowance, not a failure.
//
// To measure actual ingest capacity instead, relax the @Throttle on that route
// (or run against a stack behind a load balancer with several source IPs).
//
// Each iteration posts a batch of BATCH_SIZE events (default 20, API max 100).
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3100';
const BATCH_SIZE = Number(__ENV.BATCH_SIZE || 20);

/**
 * The beacon endpoint is deliberately rate limited (600 req/min per IP), and
 * 50 VUs exceed that on purpose. A 429 is the throttler working, not an ingest
 * failure, so it is tracked separately and excluded from the error threshold.
 */
const throttled = new Rate('throttled_requests');

export const options = {
  stages: [
    { duration: '30s', target: 50 }, // ramp up 0 → 50 VUs
    { duration: '60s', target: 50 }, // steady
    { duration: '15s', target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'], // fire-and-forget 202 must stay fast
    // Only non-throttled outcomes count as errors — see `throttled` above.
    'checks{kind:accepted}': ['rate>0.99'],
  },
};

// The payload must satisfy TrackEventDto exactly: it forbids unknown
// properties and `eventId` is @IsUUID(), so a stray key or a non-UUID id makes
// every request a 400 and the run measures rejection instead of ingest.
function makeBatch(vu, iter) {
  const events = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    events.push({
      eventId: uuidv4(),
      eventName: 'load_test_event',
      anonymousId: `k6-anon-${vu}`,
      sessionId: `k6-session-${vu}-${iter}`,
      page: '/load-test',
      referrer: 'k6',
      timestamp: Date.now(),
      props: { source: 'k6', batchIndex: i },
    });
  }
  return { events };
}

export default function () {
  const res = http.post(
    `${BASE_URL}/api/v1/track`,
    JSON.stringify(makeBatch(__VU, __ITER)),
    { headers: { 'Content-Type': 'application/json' } },
  );
  throttled.add(res.status === 429);

  check(
    res,
    {
      // Guard the body: on a transport error r.body is null and r.json()
      // throws, which aborts the iteration instead of failing a check.
      'accepted or throttled': (r) =>
        r.status === 429 ||
        (r.status === 202 && !!r.body && r.json('accepted') === BATCH_SIZE),
    },
    { kind: 'accepted' },
  );
}
