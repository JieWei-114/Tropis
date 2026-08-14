import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Outbox, OutboxSchema } from './outbox.schema';
import { OutboxService } from './outbox.service';
import { OutboxRelay } from './outbox.relay';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Outbox.name, schema: OutboxSchema }]),
  ],
  providers: [OutboxService, OutboxRelay],
  exports: [OutboxService],
})
export class OutboxModule {}
