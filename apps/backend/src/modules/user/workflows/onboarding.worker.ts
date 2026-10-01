import type { WorkflowWorkerDefinition } from '../../../infrastructure/workflow/workflow.registry';
import { ONBOARDING_QUEUE } from '../constants/onboarding.constants';
import { OnboardingActivities } from './onboarding.activities';

/**
 * What the onboarding worker runs. Imported by the user worker module only:
 * the workflows path resolves next to this file (next to the worker bundle
 * once built, see esbuild.config.mjs).
 */
export const ONBOARDING_WORKER: WorkflowWorkerDefinition = {
  queue: ONBOARDING_QUEUE,
  workflowsPath: require.resolve('./onboarding.workflow'),
  activities: OnboardingActivities,
};
