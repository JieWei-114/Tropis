import { NativeConnection, Worker } from '@temporalio/worker';
import { notificationActivities } from './activities/notification.activities';
import { loadEnv } from './env';

// Fail fast on malformed env (bad ports etc.) before touching Temporal.
const env = loadEnv();

async function run() {
  const connection = await NativeConnection.connect({ address: env.temporalAddress });
  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows/notification.workflow'),
    activities: notificationActivities,
    taskQueue: env.taskQueue,
    connection,
    namespace: env.temporalNamespace,
  });

  console.log(`Temporal worker running — queue: ${env.taskQueue}, server: ${env.temporalAddress}`);
  await worker.run();
}

run().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});
