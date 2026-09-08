import { Module } from '@nestjs/common';
import { NotificationModule } from '../../modules/notification/notification.module';
import { TemporalWorkerService } from './temporal.worker';

/**
 * Hosts the in-process Temporal worker.
 *
 * Kept separate from the global TemporalModule, which only provides the client:
 * the worker starts a long-running poller, so it must be possible to load the
 * client without also starting one (tests, CLI scripts, the HTTP-only path).
 * NotificationModule is imported for its activities; it happens to be @Global,
 * so the import is documentation of the dependency rather than load-bearing.
 */
@Module({
  imports: [NotificationModule],
  providers: [TemporalWorkerService],
})
export class TemporalWorkerModule {}
