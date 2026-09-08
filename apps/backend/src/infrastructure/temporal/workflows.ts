/**
 * Temporal workflow definitions.
 *
 * This file runs inside Temporal's deterministic V8 sandbox — no direct I/O,
 * no Date.now-driven branching, no imports of NestJS or Node built-ins. Side
 * effects happen only through activities (proxied below). The worker bundles
 * this file; see temporal.worker.ts.
 */
import { proxyActivities, sleep } from '@temporalio/workflow';
import type { OnboardingActivities } from './activities';

export interface OnboardingInput {
  userId: string;
  email: string;
  name: string;
  /** How long to wait before the follow-up. A durable timer, not setTimeout. */
  delayMs: number;
}

export interface OnboardingResult {
  userId: string;
  followUpSentAt: number;
}

const { sendFollowUpEmail } = proxyActivities<OnboardingActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, initialInterval: '2s' },
});

/**
 * Onboarding follow-up: after a user signs up, wait, then send a nudge email.
 *
 * The point of doing this in Temporal (rather than a BullMQ delayed job) is the
 * durable timer: if the whole backend restarts mid-wait, Temporal resumes the
 * timer exactly where it left off and still fires the follow-up — no lost jobs,
 * no double-sends.
 */
export async function userOnboardingWorkflow(
  input: OnboardingInput,
): Promise<OnboardingResult> {
  await sleep(input.delayMs);
  await sendFollowUpEmail({
    userId: input.userId,
    email: input.email,
    name: input.name,
  });
  return { userId: input.userId, followUpSentAt: Date.now() };
}
