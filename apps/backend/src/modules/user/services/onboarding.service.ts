import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import {
  WORKFLOW,
  type WorkflowExecution,
  type WorkflowPort,
} from '../../../infrastructure/workflow/workflow.port';
import {
  ONBOARDING_ID_PREFIX,
  ONBOARDING_SUMMARY_LIMIT,
  ONBOARDING_TIMEOUT_MARGIN_MS,
  ONBOARDING_WORKFLOW,
  type OnboardingInput,
} from '../constants/onboarding.constants';

export interface OnboardingItem {
  workflowId: string;
  userId: string;
  status: string;
  /** ISO 8601 UTC, or null while unknown. */
  startTime: string | null;
  closeTime: string | null;
}

export interface OnboardingSummary {
  available: boolean;
  summary: { running: number; completed: number };
  items: OnboardingItem[];
}

/** The durable onboarding follow-up of a new user, over the workflow port. */
@Injectable()
export class OnboardingService {
  private readonly logger = createLogger('user');
  private readonly followUpDelayMs: number;

  constructor(
    @Inject(WORKFLOW) private readonly workflows: WorkflowPort,
    config: ConfigService,
  ) {
    this.followUpDelayMs = config.getOrThrow<number>(
      'ONBOARDING_FOLLOWUP_DELAY_MS',
    );
  }

  /**
   * Starts the follow-up when the engine is available. Fire-and-forget and
   * tolerant of the engine being down: sign-up must never fail because of
   * it, and a failed start is logged, not retried.
   */
  start(
    tenantId: TenantId,
    user: { userId: string; email: string; name: string },
  ): void {
    if (!this.workflows.isAvailable()) return;
    const input: OnboardingInput = {
      tenantId,
      userId: user.userId,
      email: user.email,
      name: user.name,
      delayMs: this.followUpDelayMs,
    };
    this.workflows
      .start(tenantId, ONBOARDING_WORKFLOW, [input], {
        workflowId: `${ONBOARDING_ID_PREFIX}${user.userId}`,
        executionTimeoutMs: this.followUpDelayMs + ONBOARDING_TIMEOUT_MARGIN_MS,
      })
      .catch((e: unknown) =>
        this.logger.warn(
          'onboarding-start-failed',
          'Onboarding workflow start failed',
          { 'user.id': user.userId },
          e,
        ),
      );
  }

  /** The tenant's onboarding counts and recent executions; empty while the engine is unavailable. */
  async summary(tenantId: TenantId): Promise<OnboardingSummary> {
    if (!this.workflows.isAvailable()) {
      return {
        available: false,
        summary: { running: 0, completed: 0 },
        items: [],
      };
    }
    const [running, completed, executions] = await Promise.all([
      this.workflows.count(tenantId, ONBOARDING_WORKFLOW, 'running'),
      this.workflows.count(tenantId, ONBOARDING_WORKFLOW, 'completed'),
      this.workflows.list(
        tenantId,
        ONBOARDING_WORKFLOW,
        ONBOARDING_SUMMARY_LIMIT,
      ),
    ]);
    return {
      available: true,
      summary: { running, completed },
      items: executions.map(toItem),
    };
  }
}

function toItem(wf: WorkflowExecution): OnboardingItem {
  return {
    workflowId: wf.workflowId,
    userId: wf.workflowId.startsWith(ONBOARDING_ID_PREFIX)
      ? wf.workflowId.slice(ONBOARDING_ID_PREFIX.length)
      : wf.workflowId,
    status: wf.status,
    startTime: isoOrNull(wf.startTime),
    closeTime: isoOrNull(wf.closeTime),
  };
}

function isoOrNull(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}
