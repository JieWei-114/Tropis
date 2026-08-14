/**
 * Dev data seeder — exercises the REAL running backend over gRPC.
 *
 * Creates: 1 admin user + 20 demo users (UserService/Create) and ~50
 * analytics events of mixed types (AnalyticsService/CreateEvent).
 *
 * Requires the backend to be running (`make up && make dev`); it checks
 * http://localhost:3100/api/health first and exits with a friendly message
 * if the stack is down.
 *
 * Run: `make seed`  (→ pnpm --filter @tropis/backend seed)
 *
 * Idempotent-ish: user Create calls pass an idempotency_key, so re-running
 * the seeder does not duplicate users (duplicate-email errors are also
 * tolerated and reported as "skipped").
 */
import * as grpc from '@grpc/grpc-js';
import { GRPC_ADDRESS, call, checkHealth, loadService } from './lib/grpc';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';

const EVENT_TYPES = [
  'page_view',
  'button_click',
  'api_call',
  'error',
  'purchase',
] as const;

interface GrpcUser {
  id: string;
  name: string;
  email: string;
}

async function main(): Promise<void> {
  await checkHealth();
  console.log(`✓ Backend healthy — seeding via gRPC at ${GRPC_ADDRESS}\n`);

  const UserService = loadService(
    'user/v1/user.proto',
    ['tropis', 'user', 'v1'],
    'UserService',
  );
  const AnalyticsService = loadService(
    'analytics/v1/analytics.proto',
    ['tropis', 'analytics', 'v1'],
    'AnalyticsService',
  );

  const creds = grpc.credentials.createInsecure();
  const users = new UserService(GRPC_ADDRESS, creds);
  const analytics = new AnalyticsService(GRPC_ADDRESS, creds);

  // ── Users ─────────────────────────────────────────────────────────
  const toCreate = [
    { name: 'Admin', email: 'admin@example.com', age: 35 },
    ...Array.from({ length: 20 }, (_, i) => ({
      name: `Demo User ${String(i + 1).padStart(2, '0')}`,
      email: `demo${String(i + 1).padStart(2, '0')}@example.com`,
      age: 20 + ((i * 3) % 40),
    })),
  ];

  const created: GrpcUser[] = [];
  let skipped = 0;
  for (const u of toCreate) {
    try {
      const res = await call<GrpcUser>(users, 'Create', {
        ...u,
        password: PASSWORD,
        idempotency_key: `seed-${u.email}`,
      });
      created.push(res);
      console.log(`  + user ${res.email} (${res.id})`);
    } catch (err) {
      skipped++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ~ skipped ${u.email}: ${msg.split('\n')[0]}`);
    }
  }
  console.log(
    `\nUsers: ${created.length} created, ${skipped} skipped (already exist)\n`,
  );

  // ── Analytics events ──────────────────────────────────────────────
  const userIds = created.map((u) => u.id);
  if (userIds.length === 0) userIds.push('seed-anonymous');

  let events = 0;
  for (let i = 0; i < 50; i++) {
    const eventType = EVENT_TYPES[i % EVENT_TYPES.length];
    const userId = userIds[i % userIds.length];
    try {
      await call(analytics, 'CreateEvent', {
        event_type: eventType,
        user_id: userId,
        metadata: JSON.stringify({
          source: 'seed-script',
          seq: i,
          page: `/demo/${i % 7}`,
        }),
      });
      events++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `  ~ event ${i} (${eventType}) failed: ${msg.split('\n')[0]}`,
      );
    }
  }
  console.log(
    `Analytics: ${events}/50 events fired (types: ${EVENT_TYPES.join(', ')})\n`,
  );

  console.log(`Done. Log in with admin@example.com / ${PASSWORD}`);
  users.close();
  analytics.close();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
