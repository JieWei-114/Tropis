/**
 * Activity contract for Temporal workflows.
 *
 * Only the TYPES live here — the implementations are supplied by the worker
 * (temporal.worker.ts) so they can reach into NestJS-injected services such as
 * NotificationService. Workflow code imports these as `import type`, which keeps
 * the deterministic workflow sandbox free of any real I/O.
 */
export interface FollowUpInput {
  userId: string;
  email: string;
  name: string;
}

export interface OnboardingActivities {
  /** Sends the delayed onboarding follow-up email (via NotificationService → SMTP). */
  sendFollowUpEmail(input: FollowUpInput): Promise<void>;
}
