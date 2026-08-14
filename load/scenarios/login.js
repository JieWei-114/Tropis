// Login flow — POST /api/auth/login (REST, apps/backend/src/modules/auth/
// controllers/auth.controller.ts). Password login returns JWT access +
// refresh tokens; we also hit GET /api/auth/me with the access token to
// exercise the JWT guard path.
//
// NOTE: the endpoint is throttled at 10 attempts/min/IP (@Throttle on the
// controller). From a single machine most iterations beyond that will get
// 429 — this scenario therefore stays deliberately low-VU and measures
// latency of successful logins, not raw login throughput. 429s are counted
// separately and excluded from the failure threshold via expected_response.
//
// Credentials default to the seeded admin (make seed): admin@example.com /
// Password123! — override with LOGIN_EMAIL / LOGIN_PASSWORD.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3100';
const EMAIL = __ENV.LOGIN_EMAIL || 'admin@example.com';
const PASSWORD = __ENV.LOGIN_PASSWORD || 'Password123!';

const throttled = new Rate('login_throttled');

export const options = {
  stages: [
    { duration: '20s', target: 3 }, // ramp up (low — rate limit is 10/min/IP)
    { duration: '40s', target: 3 }, // steady
    { duration: '10s', target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // bcrypt makes login slower than reads
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    {
      headers: { 'Content-Type': 'application/json' },
      // 429 (throttled) is an expected outcome under load — don't count it
      // as a protocol failure, track it in its own metric instead.
      responseCallback: http.expectedStatuses(200, 201, 429),
    },
  );

  throttled.add(res.status === 429);

  if (res.status !== 429) {
    const ok = check(res, {
      'login succeeded': (r) => r.status === 200 || r.status === 201,
      'got access token': (r) => !!(r.json('accessToken') || r.json('access_token')),
    });

    if (ok) {
      const token = res.json('accessToken') || res.json('access_token');
      const me = http.get(`${BASE_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      check(me, { 'me returns 200': (r) => r.status === 200 });
    }
  }

  sleep(5); // pace VUs to stay near the rate limit, not blow through it
}
