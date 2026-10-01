import { Module } from '@nestjs/common';
import { AnalyticsWorkerModule } from '../../features/analytics/analytics-worker.module';
import { MembershipGraphWorkerModule } from '../../features/membership-graph/membership-graph-worker.module';
import { TrackingWorkerModule } from '../../features/tracking/tracking-worker.module';
import { JobsWorkersModule } from '../../infrastructure/jobs/jobs-workers.module';
import { OutboxRelayModule } from '../../infrastructure/outbox/outbox-relay.module';
import { WorkflowWorkerModule } from '../../infrastructure/workflow/workflow-worker.module';
import { NotificationModule } from '../../modules/notification/notification.module';
import { UserWorkerModule } from '../../modules/user/user-worker.module';
import { CoreModule } from '../shared/core.module';

/**
 * Worker role: message consumers, the outbox relay, job workers and the
 * workflow workers. No inbound API.
 */
@Module({
  imports: [
    CoreModule,
    JobsWorkersModule,
    OutboxRelayModule,
    WorkflowWorkerModule.forRoot(),
    NotificationModule,
    UserWorkerModule,

    AnalyticsWorkerModule,
    TrackingWorkerModule,
    MembershipGraphWorkerModule,
  ],
})
export class WorkerModule {}
