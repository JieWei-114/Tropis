import type { EnqueueOptions } from './jobs.port';

/** A queue, declared by the module that owns it (JobsModule.forFeature). */
export interface JobQueueDefinition {
  name: string;
  /** Applied under the caller's EnqueueOptions on every enqueue. */
  defaults: EnqueueOptions;
  /** Move a job to QUEUE_DLQ once its retries are exhausted. */
  deadLetter: boolean;
}

/** Jobs that exhausted their retries on a `deadLetter` queue, owned by the capability. */
export const QUEUE_DLQ = 'dead-letter';

export const DEAD_LETTER_QUEUE: JobQueueDefinition = {
  name: QUEUE_DLQ,
  defaults: { removeOnComplete: false, removeOnFail: false },
  deadLetter: false,
};

/** The JobQueueRegistry of the process. */
export const JOB_QUEUES = Symbol('JOB_QUEUES');

export class UnknownJobQueueError extends Error {
  constructor(queue: string) {
    super(
      `Unknown job queue ${JSON.stringify(queue)}; register it with JobsModule.forFeature`,
    );
    this.name = 'UnknownJobQueueError';
  }
}

/**
 * The queues this process serves: the dead-letter queue plus every queue a
 * module imported with JobsModule.forFeature. A queue exists in a role only
 * when a module of that role declares it.
 */
export class JobQueueRegistry {
  private readonly queues = new Map<string, JobQueueDefinition>([
    [QUEUE_DLQ, DEAD_LETTER_QUEUE],
  ]);

  register(definition: JobQueueDefinition): void {
    const existing = this.queues.get(definition.name);
    if (existing && existing !== definition) {
      throw new Error(
        `Job queue ${JSON.stringify(definition.name)} is declared twice`,
      );
    }
    this.queues.set(definition.name, definition);
  }

  get(name: string): JobQueueDefinition {
    const definition = this.queues.get(name);
    if (!definition) throw new UnknownJobQueueError(name);
    return definition;
  }

  names(): string[] {
    return [...this.queues.keys()];
  }
}
