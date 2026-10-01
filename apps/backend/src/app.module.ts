import { Module } from '@nestjs/common';
import { PrivateModule } from './roles/private/private.module';
import { PublicModule } from './roles/public/public.module';
import { SchedulerModule } from './roles/scheduler/scheduler.module';
import { WorkerModule } from './roles/worker/worker.module';

/**
 * The `all` role: every role in one process, for local development and the
 * e2e suite. Deployments run each role from its own entry point
 * (src/roles/<role>/main.ts).
 */
@Module({
  imports: [PublicModule, PrivateModule, WorkerModule, SchedulerModule],
})
export class AppModule {}
