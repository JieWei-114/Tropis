import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { MESSAGE_BROKER } from '../../../infrastructure/messaging/message-broker.port';
import type {
  MessageBrokerPort,
  MessageSubscription,
} from '../../../infrastructure/messaging/message-broker.port';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import { IEventLog } from '../interfaces/analytics.interface';
import {
  ANALYTICS_TOPIC,
  ANALYTICS_SUBSCRIPTION,
} from '../constants/analytics.constants';

/**
 * Listens to the analytics topic and writes each event into ClickHouse.
 *
 * Flow:
 *   broker "analytics-events"
 *     → AnalyticsProcessor handler
 *       → parse JSON → AnalyticsRepository.insertEvent()
 *         → ClickHouse logs.analytics_events
 *
 * Flink does the same but adds windowed aggregations on top.
 * Both can run simultaneously — they use different subscription names.
 */
@Injectable()
export class AnalyticsProcessor implements OnModuleInit, OnModuleDestroy {
  private subscription: MessageSubscription | null = null;

  constructor(
    @InjectPinoLogger(AnalyticsProcessor.name)
    private readonly logger: PinoLogger,
    private readonly analyticsRepo: AnalyticsRepository,
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBrokerPort,
  ) {}

  async onModuleInit() {
    try {
      this.subscription = await this.broker.subscribe(
        ANALYTICS_TOPIC,
        ANALYTICS_SUBSCRIPTION,
        (data) => this.handle(JSON.parse(data.toString()) as IEventLog),
        { type: 'shared' },
      );
      this.logger.info('AnalyticsProcessor started');
    } catch {
      this.logger.warn('AnalyticsProcessor: broker not available, skipping');
    }
  }

  async onModuleDestroy() {
    await this.subscription?.close();
  }

  private async handle(event: IEventLog) {
    this.logger.info(
      { eventId: event.eventId, eventType: event.eventType },
      'AnalyticsProcessor: writing to ClickHouse',
    );

    await this.analyticsRepo.insertEvent({
      event_id: event.eventId,
      event_type: event.eventType,
      user_id: event.userId,
      payload: JSON.stringify(event.metadata),
      ts: event.timestamp,
    });
  }
}
