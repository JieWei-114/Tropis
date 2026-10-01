/**
 * Creates one fresh user over RPC and prints `<workflowId> <email>`.
 *
 * Used by scripts/temporal-demo.sh, which needs the workflow id to poll
 * Temporal and the email to count follow-up mails in Mailpit. It goes through
 * the real UserService/Create so the whole pipeline runs — outbox -> Pulsar ->
 * UserProcessor -> userOnboardingWorkflow — which is the point of the demo.
 *
 * The workflow id is the engine-side id: the processor's `onboarding-<userId>`
 * behind the workflow port's tenant prefix `t.<tenantId>:`; keep them in step.
 *
 * Run: `npx ts-node scripts/create-demo-user.ts` (or via `make wf-demo`).
 */
import { UserService } from '../src/gen/user/v1/user_pb';
import { TENANT_ID, checkHealth, rpcClient } from './lib/rpc';

const PASSWORD = process.env.DEMO_PASSWORD ?? 'Password123!';

async function main(): Promise<void> {
  await checkHealth();

  const users = rpcClient(UserService);

  // Unique per run so each demo gets its own workflow and its own mailbox.
  const stamp = Date.now();
  const email = `wfdemo-${stamp}@example.com`;

  const user = await users.create({
    name: `Workflow Demo ${stamp}`,
    email,
    password: PASSWORD,
    age: 30,
    idempotencyKey: `wf-demo-${stamp}`,
  });

  // stdout is parsed by the demo script — one line, two fields, nothing else.
  console.log(`t.${TENANT_ID}:onboarding-${user.id} ${user.email}`);
}

main().catch((err: Error) => {
  console.error(`create-demo-user failed: ${err.message}`);
  process.exit(1);
});
