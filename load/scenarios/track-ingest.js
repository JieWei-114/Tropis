// High-throughput batch ingest — POST /api/v1/track (public beacon endpoint,
// apps/backend/src/modules/tracking/controllers/tracking.controller.ts).
// The endpoint answers 202 immediately and publishes asynchronously, so this
// measures the HTTP ingest path, not end-to-end pipeline latency.
//
// Ramp 0 → 50 VUs. Each iteration posts a batch of BATCH_SIZE events
// (default 20, max accepted by the API is 100).
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3100';
const BATCH_SIZE = Number(__ENV.BATCH_SIZE || 20);

export const options = {
  stages: [
    { duration: '30s', target: 50 }, // ramp up 0 → 50 VUs
    { duration: '60s', target: 50 }, // steady
    { duration: '15s', target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'], // fire-and-forget 202 must stay fast
    http_req_failed: ['rate<0.01'],
  },
};

function makeBatch(vu, iter) {
  const events = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    events.push({
      eventId: `k6-${vu}-${iter}-${i}-${Date.now()}`,
      eventName: 'load_test_event',
      anonymousId: `k6-anon-${vu}`,
      sessionId: `k6-session-${vu}-${iter}`,
      page: '/load-test',
      referrer: 'k6',
      timestamp: Date.now(),
      properties: { source: 'k6', batchIndex: i },
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
  check(res, {
    'status is 202': (r) => r.status === 202,
    'accepted full batch': (r) => r.json('accepted') === BATCH_SIZE,
  });
}
