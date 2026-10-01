import { Module } from '@nestjs/common';
import { CacheModule } from '../../infrastructure/cache/cache.module';
import { MessagingModule } from '../../infrastructure/messaging/messaging.module';
import { RealtimeModule } from '../../infrastructure/realtime/realtime.module';
import { WorkflowWorkerModule } from '../../infrastructure/workflow/workflow-worker.module';
import { NotificationModule } from '../notification/notification.module';
import { UserProcessor } from './processors/user.processor';
import { UserProjectionService } from './services/user-projection.service';
import { UserModule } from './user.module';
import { UserOnboardingModule } from './user-onboarding.module';
import { UserSearchModule } from './user-search.module';
import { OnboardingActivities } from './workflows/onboarding.activities';
import { ONBOARDING_WORKER } from './workflows/onboarding.worker';

/** Consumes user events (search, vectors, cache, welcome email, onboarding) and runs the onboarding workflow. */
@Module({
  imports: [
    UserModule,
    UserSearchModule,
    UserOnboardingModule,
    NotificationModule,
    CacheModule.forRoot(),
    MessagingModule.forRoot(),
    RealtimeModule.forRoot(),
    WorkflowWorkerModule.forFeature(ONBOARDING_WORKER),
  ],
  providers: [UserProcessor, UserProjectionService, OnboardingActivities],
})
export class UserWorkerModule {}
