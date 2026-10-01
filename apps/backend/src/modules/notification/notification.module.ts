import { Module } from '@nestjs/common';
import { JobsModule } from '../../infrastructure/jobs/jobs.module';
import { MailModule } from '../../infrastructure/mail/mail.module';
import { RealtimeModule } from '../../infrastructure/realtime/realtime.module';
import { NOTIFICATION_QUEUE } from './constants/notification.constants';
import { NotificationProcessor } from './processors/notification.processor';
import { NotificationService } from './services/notification.service';

/**
 * Notification delivery (mail, in-app push) and the notification queue. Its
 * job handler runs where a job worker runs (the worker role); producers
 * enqueue through NotificationService.enqueue().
 */
@Module({
  imports: [
    JobsModule.forFeature([NOTIFICATION_QUEUE]),
    MailModule.forRoot(),
    RealtimeModule.forRoot(),
  ],
  providers: [NotificationService, NotificationProcessor],
  exports: [NotificationService],
})
export class NotificationModule {}
