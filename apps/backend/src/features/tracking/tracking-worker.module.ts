import { Module } from '@nestjs/common';
import { MessagingModule } from '../../infrastructure/messaging/messaging.module';
import { RealtimeModule } from '../../infrastructure/realtime/realtime.module';
import { TrackingModule } from './tracking.module';
import { TrackingProcessor } from './processors/tracking.processor';
import { TrackingSinkService } from './services/tracking-sink.service';

/** Broker → OLAP sink for tracking events. */
@Module({
  imports: [
    TrackingModule,
    MessagingModule.forRoot(),
    RealtimeModule.forRoot(),
  ],
  providers: [TrackingSinkService, TrackingProcessor],
})
export class TrackingWorkerModule {}
