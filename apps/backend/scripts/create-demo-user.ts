/**
 * Creates one fresh user over gRPC and prints `<workflowId> <email>`.
 *
 * Used by scripts/temporal-demo.sh, which needs the workflow id to poll
 * Temporal and the email to count follow-up mails in MailHog. It goes through
 * the real UserService/Create so the whole pipeline runs — outbox -> Pulsar ->
 * UserProcessor -> userOnboardingWorkflow — which is the point of the demo.
 *
 * The workflow id is derived the same way the processor derives it
 * (`onboarding-<userId>`); keep the two in step.
 *
 * Run: `npx ts-node scripts/create-demo-user.ts` (or via `make wf-demo`).
 */
import * as grpc from '@grpc/grpc-js';
import { GRPC_ADDRESS, call, checkHealth, loadService } from './lib/grpc';

const PASSWORD = process.env.DEMO_PASSWORD ?? 'Password123!';

interface GrpcUser {
  id: string;
  email: string;
}

async function main(): Promise<void> {
  await checkHealth();

  const UserService = loadService(
    'user/v1/user.proto',
    ['tropis', 'user', 'v1'],
    'UserService',
  );
  const users = new UserService(
    GRPC_ADDRESS,
    grpc.credentials.createInsecure(),
  );

  // Unique per run so each demo gets its own workflow and its own mailbox.
  const stamp = Date.now();
  const email = `wfdemo-${stamp}@example.com`;

  const user = await call<GrpcUser>(users, 'Create', {
    name: `Workflow Demo ${stamp}`,
    email,
    password: PASSWORD,
    age: 30,
    idempotency_key: `wf-demo-${stamp}`,
  });

  // stdout is parsed by the demo script — one line, two fields, nothing else.
  console.log(`onboarding-${user.id} ${user.email}`);
}

main().catch((err: Error) => {
  console.error(`create-demo-user failed: ${err.message}`);
  process.exit(1);
});
