import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Outbox, OutboxSchema } from './outbox.schema';
import { OutboxService } from './outbox.service';
import { OutboxRelay } from './outbox.relay';
import { MetricsModule } from '../../modules/metrics/metrics.module';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Outbox.name, schema: OutboxSchema }]),
    // For the backlog/heartbeat gauges the relay publishes.
    MetricsModule,
  ],
  providers: [OutboxService, OutboxRelay],
  exports: [OutboxService],
})
export class OutboxModule {}
