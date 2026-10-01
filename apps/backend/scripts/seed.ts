/**
 * Dev data seeder — exercises the REAL running backend over RPC (Connect).
 *
 * Registers the tenant (TENANT_ID, default `dev`) with self sign-up on,
 * signs up the admin account and grants it admin (both directly in the
 * database, the one step the API cannot do), then as that admin creates 20
 * demo users (UserService/Create) and ~50 analytics events of mixed types
 * (AnalyticsService/CreateEvent).
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
import { AnalyticsService } from '../src/gen/analytics/v1/analytics_pb';
import { UserService } from '../src/gen/user/v1/user_pb';
import {
  RPC_URL,
  TENANT_ID,
  bearer,
  checkHealth,
  loginForToken,
  rpcClient,
} from './lib/rpc';
import { grantAdmin, registerTenant, withDb } from './lib/db';

const ADMIN = { name: 'Admin', email: 'admin@example.com', age: 35 };

const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';

const EVENT_TYPES = [
  'page_view',
  'button_click',
  'api_call',
  'error',
  'purchase',
] as const;

async function main(): Promise<void> {
  await checkHealth();
  console.log(`✓ Backend healthy — seeding via RPC at ${RPC_URL}\n`);

  const users = rpcClient(UserService);
  const analytics = rpcClient(AnalyticsService);

  // ── Tenant + admin ────────────────────────────────────────────────
  await withDb(() =>
    registerTenant({ id: TENANT_ID, name: TENANT_ID, selfSignup: true }),
  );
  console.log(`  + tenant ${TENANT_ID} (self sign-up on)`);

  const created: { id: string; email: string }[] = [];
  let skipped = 0;
  try {
    const res = await users.create({
      ...ADMIN,
      password: PASSWORD,
      idempotencyKey: `seed-${ADMIN.email}`,
    });
    created.push(res);
    console.log(`  + user ${res.email} (${res.id})`);
  } catch (err) {
    skipped++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ~ skipped ${ADMIN.email}: ${msg.split('\n')[0]}`);
  }
  const granted = await withDb(() => grantAdmin(TENANT_ID, ADMIN.email));
  if (granted === 'missing') {
    throw new Error(`${ADMIN.email} could not be created in ${TENANT_ID}`);
  }

  // Everything below runs as the admin: creating users for others and
  // writing analytics events both need roles a self-registered member lacks.
  const auth = bearer(await loginForToken(ADMIN.email, PASSWORD));

  // ── Users ─────────────────────────────────────────────────────────
  const toCreate = [
    ...Array.from({ length: 20 }, (_, i) => ({
      name: `Demo User ${String(i + 1).padStart(2, '0')}`,
      email: `demo${String(i + 1).padStart(2, '0')}@example.com`,
      age: 20 + ((i * 3) % 40),
    })),
  ];

  for (const u of toCreate) {
    try {
      const res = await users.create(
        {
          ...u,
          password: PASSWORD,
          idempotencyKey: `seed-${u.email}`,
        },
        auth,
      );
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
      await analytics.createEvent(
        {
          eventType,
          userId,
          metadata: JSON.stringify({
            source: 'seed-script',
            seq: i,
            page: `/demo/${i % 7}`,
          }),
        },
        auth,
      );
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

  console.log(
    `Done. Log in to tenant ${TENANT_ID} with ${ADMIN.email} / ${PASSWORD} (admin).`,
  );
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
