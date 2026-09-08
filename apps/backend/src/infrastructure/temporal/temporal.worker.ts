import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { NotificationGateway } from '../../modules/websocket/gateways/notification.gateway';
import { TemporalService } from './temporal.service';
import { TEMPORAL_TASK_QUEUE } from './temporal.constants';
import type { OnboardingActivities } from './activities';

/**
 * Runs a Temporal worker in-process: it polls the "main" task queue, executes
 * the workflows bundled from workflows.ts, and runs the activities defined here.
 *
 * Activities close over NestJS-injected services (NotificationService), which is
 * how workflow code — sandboxed and I/O-free — ends up sending a real email.
 *
 * Degrades gracefully: if Temporal isn't reachable the worker is skipped and the
 * rest of the app runs normally (mirrors TemporalModule's client behaviour).
 */
@Injectable()
export class TemporalWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TemporalWorkerService.name);
  private worker?: Worker;
  private runPromise?: Promise<void>;

  constructor(
    private readonly temporal: TemporalService,
    private readonly notifications: NotificationService,
    private readonly gateway: NotificationGateway,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.temporal.available) {
      this.logger.warn(
        'Temporal not available — onboarding worker not started',
      );
      return;
    }

    const address = this.config.get<string>(
      'TEMPORAL_ADDRESS',
      'localhost:7233',
    );
    const namespace = this.config.get<string>('TEMPORAL_NAMESPACE', 'default');

    const activities: OnboardingActivities = {
      sendFollowUpEmail: async ({ name, email }) => {
        await this.notifications.sendEmail({
          to: email,
          subject: 'Getting started with Tropis',
          html: `<p>Hi ${name}, just checking in — need a hand getting started?</p>`,
        });
        this.logger.log(`Onboarding follow-up email sent to ${email}`);

        // Cosmetic console toast — deliberately AFTER the email and swallowed.
        // If this threw, Temporal would retry the whole activity (up to 5x) and
        // resend an email that already went out.
        try {
          this.gateway.broadcast('notification', {
            message: `Onboarding follow-up sent to ${name}`,
          });
        } catch (err) {
          this.logger.warn(
            `Follow-up broadcast failed (email was sent): ${(err as Error).message}`,
          );
        }
      },
    };

    try {
      const connection = await NativeConnection.connect({ address });
      this.worker = await Worker.create({
        connection,
        namespace,
        taskQueue: TEMPORAL_TASK_QUEUE,
        workflowsPath: require.resolve('./workflows'),
        activities,
      });
      // Fire-and-forget: worker.run() resolves only on shutdown.
      this.runPromise = this.worker.run();
      this.logger.log(
        `Temporal worker started on task queue "${TEMPORAL_TASK_QUEUE}"`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to start Temporal worker — onboarding workflow disabled (${(err as Error).message})`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.worker?.shutdown();
    await this.runPromise?.catch(() => undefined);
  }
}
