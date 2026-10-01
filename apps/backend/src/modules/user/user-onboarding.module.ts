import { Module } from '@nestjs/common';
import { WorkflowModule } from '../../infrastructure/workflow/workflow.module';
import {
  ONBOARDING_QUEUE,
  ONBOARDING_WORKFLOW,
} from './constants/onboarding.constants';
import { OnboardingService } from './services/onboarding.service';

/** The onboarding follow-up: starting it (worker) and reading it (public). */
@Module({
  imports: [
    WorkflowModule.forFeature({
      queue: ONBOARDING_QUEUE,
      workflowTypes: [ONBOARDING_WORKFLOW],
    }),
  ],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class UserOnboardingModule {}
