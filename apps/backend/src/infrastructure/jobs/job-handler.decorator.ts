import { SetMetadata } from '@nestjs/common';

export const JOB_HANDLER_METADATA = 'tropis:job-handler';

/**
 * Marks a provider as the consumer of `queue`. The class implements
 * JobProcessor; the jobs adapter discovers it and runs it for every job on
 * the queue (one at a time per process).
 */
export const JobHandler = (queue: string): ClassDecorator =>
  SetMetadata(JOB_HANDLER_METADATA, queue);
