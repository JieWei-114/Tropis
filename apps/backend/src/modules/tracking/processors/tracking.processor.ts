import {
  Injectable,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { MESSAGE_BROKER } from '../../../infrastructure/messaging/message-broker.port';
import type {
  MessageBrokerPort,
  MessageSubscription,
} from '../../../infrastructure/messaging/message-broker.port';
import { TrackingRepository } from '../repositories/tracking.repository';
import {
  TRACKING_TOPIC,
  TRACKING_SUBSCRIPTION,
} from '../constants/tracking.constants';
import { ITrackingEvent } from '../interfaces/tracking.interface';

/**
 * Broker → ClickHouse sink for user-behavior events.
 *
 * Flow:
 *   POST /api/v1/track → TrackingService.ingest() → broker "tracking-events"
 *     → TrackingProcessor handler → TrackingRepository.insertEvents()
 *       → ClickHouse logs.user_behavior
 *
 * Each message already carries a whole client batch, so every receive
 * is a natural batch insert. Flink (flink/) is the scale-out alternative when
 * a single Node consumer stops keeping up — same topic, windowed sink.
 */
@Injectable()
export class TrackingProcessor implements OnModuleInit, OnModuleDestroy {
  private subscription: MessageSubscription | null = null;

  constructor(
    @InjectPinoLogger(TrackingProcessor.name)
    private readonly logger: PinoLogger,
    private readonly trackingRepo: TrackingRepository,
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBrokerPort,
  ) {}

  async onModuleInit() {
    try {
      this.subscription = await this.broker.subscribe(
        TRACKING_TOPIC,
        TRACKING_SUBSCRIPTION,
        (data) => this.onMessage(data),
        { type: 'shared' },
      );
      this.logger.info('TrackingProcessor started');
    } catch {
      this.logger.warn('TrackingProcessor: broker not available, skipping');
    }
  }

  async onModuleDestroy() {
    await this.subscription?.close();
  }

  private async onMessage(data: Buffer) {
    const { events } = JSON.parse(data.toString()) as {
      events: ITrackingEvent[];
    };
    await this.handle(events ?? []);
  }

  private async handle(events: ITrackingEvent[]) {
    if (events.length === 0) return;
    await this.trackingRepo.insertEvents(
      events.map((e) => ({
        event_id: e.eventId,
        event_name: e.eventName,
        anonymous_id: e.anonymousId,
        user_id: e.userId ?? '',
        session_id: e.sessionId,
        tenant_id: e.tenantId ?? 'default',
        page: e.page,
        referrer: e.referrer,
        user_agent: e.userAgent,
        screen: e.screen,
        props: JSON.stringify(e.props ?? {}),
        timestamp: e.timestamp,
      })),
    );
    this.logger.info(
      { count: events.length },
      'TrackingProcessor: batch written to ClickHouse',
    );
  }
}
