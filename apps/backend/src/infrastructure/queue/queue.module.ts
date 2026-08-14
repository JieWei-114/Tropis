import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { ConfigService } from '@nestjs/config';
import { QueueService } from './queue.service';
import { NotificationProcessor } from './notification.processor';
import { FileProcessingProcessor } from './file-processing.processor';
import { DlqProcessor } from './dlq.processor';
import {
  QUEUE_NOTIFICATION,
  QUEUE_FILE_PROCESSING,
  QUEUE_DLQ,
} from './queue.constants';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NOTIFICATION },
      { name: QUEUE_FILE_PROCESSING },
      { name: QUEUE_DLQ },
    ),
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature(
      { name: QUEUE_NOTIFICATION, adapter: BullMQAdapter },
      { name: QUEUE_FILE_PROCESSING, adapter: BullMQAdapter },
      { name: QUEUE_DLQ, adapter: BullMQAdapter },
    ),
  ],
  providers: [
    QueueService,
    NotificationProcessor,
    FileProcessingProcessor,
    DlqProcessor,
  ],
  exports: [QueueService, BullModule],
})
export class QueueModule {}
