import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JobsModule } from '../../jobs.module';
import { BullmqWorkersService } from './bullmq-workers.service';

/** A BullMQ worker for every @JobHandler provider in the process. */
@Module({
  imports: [DiscoveryModule, JobsModule.forRoot()],
  providers: [BullmqWorkersService],
})
export class BullmqWorkersModule {}
