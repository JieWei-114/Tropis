import { DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentsModule } from '../documents/documents.module';
import {
  Outbox,
  OutboxHead,
  OutboxHeadSchema,
  OutboxSchema,
} from './outbox.schema';
import { OutboxService } from './outbox.service';

/**
 * Writing outbox rows, in every module that publishes domain events. The
 * relay is OutboxRelayModule (worker role), the sweep trigger
 * OutboxScheduleModule (scheduler role).
 */
@Module({})
export class OutboxModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (OutboxModule.root ??= {
      module: OutboxModule,
      imports: [
        DocumentsModule.forRoot(),
        MongooseModule.forFeature([
          { name: Outbox.name, schema: OutboxSchema },
          { name: OutboxHead.name, schema: OutboxHeadSchema },
        ]),
      ],
      providers: [OutboxService],
      exports: [OutboxService],
    });
  }
}
