import { Module } from '@nestjs/common';
import { BullmqWorkersModule } from './adapters/bullmq/bullmq-workers.module';
import { DeadLetterJob } from './dead-letter.job';

/**
 * Worker role: runs every @JobHandler provider of the process as a queue
 * worker, and the dead-letter handler the capability owns itself.
 */
@Module({
  imports: [BullmqWorkersModule],
  providers: [DeadLetterJob],
})
export class JobsWorkersModule {}
