import { Injectable, Inject, Logger } from '@nestjs/common';
import { MESSAGE_BROKER } from '../../../infrastructure/messaging/message-broker.port';
import type { MessageBrokerPort } from '../../../infrastructure/messaging/message-broker.port';
import { TrackingRepository } from '../repositories/tracking.repository';
import { TrackBatchDto } from '../dto/track-event.dto';
import {
  TRACKING_TOPIC,
  TRACKING_INSIGHTS_DEFAULT_DAYS,
} from '../constants/tracking.constants';
import {
  ITrackingEvent,
  ITrackingInsights,
} from '../interfaces/tracking.interface';

/**
 * Ingest + read side of user-behavior tracking.
 *
 * DELIBERATE DEVIATION from the outbox rule in docs/tech-decisions.md:
 * tracking batches are published to the broker DIRECTLY, without the MongoDB
 * outbox. Behavioral events are high-volume and lossy-tolerant — losing a
 * batch during a broker hiccup costs nothing business-wise, while forcing
 * every beacon through a Mongo transaction would double the write load of
 * the hottest endpoint in the app. Domain events (user.created, …) still
 * MUST go through the outbox.
 */
@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly trackingRepo: TrackingRepository,
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBrokerPort,
  ) {}

  /**
   * Enrich the batch with the server receipt timestamp + tenant, then publish
   * it to the message broker. Fire-and-forget: failures are logged, never
   * surfaced — the controller has already answered 202.
   */
  async ingest(dto: TrackBatchDto, tenantId = 'default'): Promise<void> {
    const receivedAt = Date.now();
    const events: ITrackingEvent[] = dto.events.map((e) => ({
      eventId: e.eventId,
      eventName: e.eventName,
      anonymousId: e.anonymousId,
      userId: e.userId,
      sessionId: e.sessionId,
      tenantId,
      page: e.page,
      referrer: e.referrer ?? '',
      userAgent: e.userAgent ?? '',
      screen: e.screen ?? '',
      props: e.props ?? {},
      timestamp: e.timestamp,
      receivedAt,
    }));

    try {
      await this.broker.publish(TRACKING_TOPIC, { events });
    } catch (err) {
      // Lossy-tolerant by design — drop the batch, keep the endpoint fast.
      this.logger.warn({ err }, 'Tracking publish failed — batch dropped');
    }
  }

  /** Dashboard aggregates, straight from ClickHouse (no cache — cheap queries). */
  async getInsights(
    days = TRACKING_INSIGHTS_DEFAULT_DAYS,
  ): Promise<ITrackingInsights> {
    const window = days > 0 ? days : TRACKING_INSIGHTS_DEFAULT_DAYS;
    const [topPages, eventsByName, dailyUniques, recent] = await Promise.all([
      this.trackingRepo.getTopPages(window),
      this.trackingRepo.getEventsByName(window),
      this.trackingRepo.getDailyUniques(window),
      this.trackingRepo.getRecent(),
    ]);
    return { topPages, eventsByName, dailyUniques, recent };
  }
}
