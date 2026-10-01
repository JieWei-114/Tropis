import type { ConfigService } from '@nestjs/config';
import type { ConnectionOptions, JobsOptions } from 'bullmq';
import type { EnqueueOptions } from '../../jobs.port';

export function bullmqConnection(config: ConfigService): ConnectionOptions {
  return {
    host: config.getOrThrow<string>('REDIS_HOST'),
    port: config.getOrThrow<number>('REDIS_PORT'),
    password: config.get<string>('REDIS_PASSWORD') || undefined,
  };
}

/** Port options → BullMQ options; `undefined` fields are left out. */
export function toJobsOptions(options: EnqueueOptions): JobsOptions {
  const out: JobsOptions = {};
  if (options.jobId !== undefined) out.jobId = options.jobId;
  if (options.delayMs !== undefined) out.delay = options.delayMs;
  if (options.attempts !== undefined) out.attempts = options.attempts;
  if (options.backoff !== undefined) {
    out.backoff = {
      type: options.backoff.type,
      delay: options.backoff.delayMs,
    };
  }
  if (options.priority !== undefined) out.priority = options.priority;
  if (options.removeOnComplete !== undefined) {
    out.removeOnComplete = options.removeOnComplete;
  }
  if (options.removeOnFail !== undefined) {
    out.removeOnFail = options.removeOnFail;
  }
  return out;
}
