/**
 * The onboarding workflow definitions, run inside Temporal's deterministic
 * sandbox: no direct I/O, no Date.now-driven branching, no imports of NestJS
 * or Node built-ins. Side effects happen only through activities (proxied
 * below). The worker of ONBOARDING_QUEUE bundles this file
 * (onboarding.worker.ts).
 */
import { proxyActivities, sleep } from '@temporalio/workflow';
import type {
  OnboardingActivityFns,
  OnboardingInput,
} from '../constants/onboarding.constants';

export interface OnboardingResult {
  userId: string;
  followUpSentAt: number;
}

const { sendFollowUpEmail } = proxyActivities<OnboardingActivityFns>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, initialInterval: '2s' },
});

/**
 * Onboarding follow-up: after a user signs up, wait, then send a nudge email.
 *
 * The point of doing this in Temporal (rather than a delayed job) is the
 * durable timer: if the whole backend restarts mid-wait, Temporal resumes the
 * timer exactly where it left off and still fires the follow-up.
 */
export async function userOnboardingWorkflow(
  input: OnboardingInput,
): Promise<OnboardingResult> {
  await sleep(input.delayMs);
  await sendFollowUpEmail({
    tenantId: input.tenantId,
    userId: input.userId,
    email: input.email,
    name: input.name,
  });
  return { userId: input.userId, followUpSentAt: Date.now() };
}
