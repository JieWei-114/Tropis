import { Module } from '@nestjs/common';
import { MessagingModule } from '../../infrastructure/messaging/messaging.module';
import { MembershipGraphModule } from './membership-graph.module';
import { MembershipGraphProcessor } from './processors/membership-graph.processor';

/** Projects user events into the membership graph. */
@Module({
  imports: [MembershipGraphModule, MessagingModule.forRoot()],
  providers: [MembershipGraphProcessor],
})
export class MembershipGraphWorkerModule {}
