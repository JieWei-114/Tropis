/** Workflow type of the onboarding follow-up (workflows/onboarding.workflow.ts). */
export const ONBOARDING_WORKFLOW = 'userOnboardingWorkflow';

/** Queue the onboarding worker polls. */
export const ONBOARDING_QUEUE = 'user-onboarding';

/** Tenant-local workflow id of a user's onboarding: `onboarding-<userId>`. */
export const ONBOARDING_ID_PREFIX = 'onboarding-';

/**
 * Execution timeout beyond the follow-up delay: covers the email activity's
 * attempts (five, a minute each, with backoff between them).
 */
export const ONBOARDING_TIMEOUT_MARGIN_MS = 15 * 60 * 1000;

/** Most recent executions the onboarding summary lists. */
export const ONBOARDING_SUMMARY_LIMIT = 200;

export interface OnboardingInput {
  tenantId: string;
  userId: string;
  email: string;
  name: string;
  /** How long to wait before the follow-up. A durable timer, not setTimeout. */
  delayMs: number;
}

export interface FollowUpInput {
  tenantId: string;
  userId: string;
  email: string;
  name: string;
}

/** The activities the onboarding workflow calls (workflows/onboarding.activities.ts). */
export interface OnboardingActivityFns {
  /** Sends the delayed onboarding follow-up email. */
  sendFollowUpEmail(input: FollowUpInput): Promise<void>;
}
