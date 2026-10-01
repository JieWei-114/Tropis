import { Inject, Injectable } from '@nestjs/common';
import { isTenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import { escapeHtml } from '../../../common/utils/escape-html';
import {
  REALTIME,
  type RealtimePort,
} from '../../../infrastructure/realtime/realtime.port';
import type { WorkflowActivityProvider } from '../../../infrastructure/workflow/workflow.registry';
import { NotificationService } from '../../notification/services/notification.service';
import type {
  FollowUpInput,
  OnboardingActivityFns,
} from '../constants/onboarding.constants';

/** The onboarding workflow's activities, run by the worker of ONBOARDING_QUEUE. */
@Injectable()
export class OnboardingActivities implements WorkflowActivityProvider {
  private readonly logger = createLogger('user');

  constructor(
    private readonly notifications: NotificationService,
    @Inject(REALTIME) private readonly realtime: RealtimePort,
  ) {}

  activities(): OnboardingActivityFns {
    return {
      sendFollowUpEmail: (input) => this.sendFollowUpEmail(input),
    };
  }

  async sendFollowUpEmail({
    tenantId,
    userId,
    name,
    email,
  }: FollowUpInput): Promise<void> {
    await this.notifications.sendEmail({
      to: email,
      subject: 'Getting started with Tropis',
      html: `<p>Hi ${escapeHtml(name)}, just checking in — need a hand getting started?</p>`,
    });
    this.logger.info(
      'follow-up-email-sent',
      'Onboarding follow-up email sent',
      { 'user.id': userId },
    );

    // Cosmetic console toast, after the email and swallowed: a throw here
    // would make Temporal retry the activity and resend the email.
    try {
      if (isTenantId(tenantId)) {
        await this.realtime.publishToUser(tenantId, userId, 'notification', {
          message: `Onboarding follow-up sent to ${name}`,
        });
      }
    } catch (err) {
      this.logger.warn(
        'follow-up-push-failed',
        'Onboarding follow-up push failed; the email was sent',
        { 'user.id': userId },
        err,
      );
    }
  }
}
