/**
 * Operator actions on the jobs dead-letter queue (src/infrastructure/jobs).
 * A job of a dead-letter queue that fails its last attempt is copied to
 * `dead-letter` with `__sourceQueue`, `__sourceJobId`, `__sourceOpts` and
 * `__failReason`. Connects straight to Redis with BullMQ:
 *
 *   list              dead-lettered jobs, oldest first
 *   replay ID=<id>    retry the failed source job with a fresh attempt
 *                     budget, or re-enqueue it on its source queue with its
 *                     recorded attempts and backoff when BullMQ no longer
 *                     holds it; then remove the dead-letter entry
 *
 * Run: `pnpm --filter @tropis/devtools jobs-dlq list`
 *      `ID=<id> pnpm --filter @tropis/devtools jobs-dlq replay`
 */
import * as path from 'path';
import {
  Queue,
  type ConnectionOptions,
  type Job,
  type JobsOptions,
} from 'bullmq';
import { config } from 'dotenv';

config({
  path: path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'apps',
    'backend',
    '.env',
  ),
});

const DLQ = 'dead-letter';
const MARKERS = [
  '__sourceQueue',
  '__sourceJobId',
  '__sourceOpts',
  '__failReason',
] as const;

const connection: ConnectionOptions = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,
};

interface DeadLetterData extends Record<string, unknown> {
  __sourceQueue?: string;
  __sourceJobId?: string;
  __sourceOpts?: Pick<JobsOptions, 'attempts' | 'backoff'>;
  __failReason?: string;
}

function original(data: DeadLetterData): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const key of MARKERS) delete out[key];
  return out;
}

async function list(dlq: Queue): Promise<void> {
  const jobs = await dlq.getJobs(
    ['completed', 'waiting', 'active', 'failed', 'delayed'],
    0,
    49,
    true,
  );
  if (jobs.length === 0) console.log('No dead-lettered jobs.');
  for (const job of jobs) {
    const data = job.data as DeadLetterData;
    console.log(
      `${String(job.id)}  ${String(data.__sourceQueue)}/${job.name}` +
        `  source job ${String(data.__sourceJobId ?? '-')}` +
        `  ${new Date(job.timestamp).toISOString()}` +
        `  reason: ${String(data.__failReason ?? 'unknown').split('\n')[0]}`,
    );
  }
}

async function replay(dlq: Queue, id: string): Promise<void> {
  const job = (await dlq.getJob(id)) as Job<DeadLetterData> | undefined;
  if (!job) throw new Error(`No dead-lettered job ${JSON.stringify(id)}`);
  const source = job.data.__sourceQueue;
  if (!source) throw new Error(`Job ${id} records no source queue`);

  const queue = new Queue(source, { connection });
  try {
    const sourceJob = job.data.__sourceJobId
      ? await queue.getJob(job.data.__sourceJobId)
      : undefined;
    if (sourceJob && (await sourceJob.isFailed())) {
      await sourceJob.retry('failed', {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      console.log(`Retried ${source} job ${String(sourceJob.id)}.`);
    } else {
      const added = await queue.add(
        job.name,
        original(job.data),
        job.data.__sourceOpts ?? {},
      );
      console.log(`Re-enqueued on ${source} as job ${String(added.id)}.`);
    }
    await job.remove();
  } finally {
    await queue.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'list';
  const dlq = new Queue(DLQ, { connection });
  try {
    if (command === 'list') return await list(dlq);
    if (command === 'replay') {
      const id = process.env.ID;
      if (!id) throw new Error('Pass ID=<dead-letter job id>');
      return await replay(dlq, id);
    }
    throw new Error(`Unknown command ${command}: use list or replay`);
  } finally {
    await dlq.close();
  }
}

main().catch((err) => {
  console.error(
    `jobs-dlq failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
