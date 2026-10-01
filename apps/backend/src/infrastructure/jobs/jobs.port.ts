import type { HealthCheckable } from '../capability';

/**
 * Jobs — background work on named queues with retries. Producers enqueue
 * through JOBS; consumers are providers marked @JobHandler(queue) that the
 * adapter runs. A job whose retries are exhausted moves to the dead-letter
 * queue when its queue is registered with `deadLetter: true`. Every job
 * carries its enqueuer's tenant or global scope and runs inside it
 * (job-tenant.ts); enqueueing without one fails with TENANT_REQUIRED.
 */
export const JOBS = Symbol('JOBS');

export interface JobBackoff {
  type: 'fixed' | 'exponential';
  delayMs: number;
}

export interface EnqueueOptions {
  /** Deduplicates: a second enqueue with the same id is dropped. */
  jobId?: string;
  delayMs?: number;
  attempts?: number;
  backoff?: JobBackoff;
  priority?: number;
  /** Completed jobs to keep (count), or true/false for all/none. */
  removeOnComplete?: number | boolean;
  /** Failed jobs to keep (count), or true/false for all/none. */
  removeOnFail?: number | boolean;
}

export interface EnqueuedJob {
  id: string | undefined;
}

export interface JobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

export interface JobsPort extends HealthCheckable {
  /** Adds a job; the queue's registered defaults apply under `options`. */
  enqueue<T>(
    queue: string,
    name: string,
    data: T,
    options?: EnqueueOptions,
  ): Promise<EnqueuedJob>;
  counts(queue: string): Promise<JobCounts>;
}

/** What a handler receives for one attempt of a job. */
export interface JobContext<T = unknown> {
  id: string | undefined;
  name: string;
  data: T;
  /** Attempts already made before this one. */
  attemptsMade: number;
}

/** Implemented by @JobHandler providers; a rejection counts as a failed attempt. */
export interface JobProcessor<T = unknown> {
  process(job: JobContext<T>): Promise<void>;
}
