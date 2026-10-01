// Baseline smoke — GET /readyz on the ops port (unthrottled; /api/health is
// rate limited).
// Establishes the floor: if this scenario fails its thresholds, don't bother
// reading the login/track results — the stack itself is unhealthy.
import http from 'k6/http';
import { check, sleep } from 'k6';

const OPS_URL = __ENV.OPS_URL || 'http://localhost:9464';

export const options = {
  stages: [
    { duration: '15s', target: 5 }, // ramp up
    { duration: '30s', target: 5 }, // steady
    { duration: '15s', target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'], // 95% of requests under 200ms
    http_req_failed: ['rate<0.01'], // <1% errors
  },
};

export default function () {
  const res = http.get(`${OPS_URL}/readyz`);
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(1);
}
