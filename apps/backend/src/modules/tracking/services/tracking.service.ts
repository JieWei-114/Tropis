import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import type Redis from 'ioredis';
import { MESSAGE_BROKER } from '../../../infrastructure/messaging/message-broker.port';
import type { MessageBrokerPort } from '../../../infrastructure/messaging/message-broker.port';
import { TrackingRepository } from '../repositories/tracking.repository';
import { TrackBatchDto } from '../dto/track-event.dto';
import {
  TRACKING_TOPIC,
  TRACKING_INSIGHTS_DEFAULT_DAYS,
  trackingSeenKey,
  TRACKING_SEEN_TTL_SECONDS,
} from '../constants/tracking.constants';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { DEFAULT_TENANT } from '../../user/constants/user.enums';
import {
  ITrackingEvent,
  ITrackingInsights,
} from '../interfaces/tracking.interface';
import { TRACKING_DUPLICATES_METRIC } from '../../metrics/metrics.constants';

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
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectMetric(TRACKING_DUPLICATES_METRIC)
    private readonly duplicatesDropped: Counter<string>,
  ) {}

  /**
   * Enrich the batch with the server receipt timestamp + tenant, then publish
   * it to the message broker. Fire-and-forget: failures are logged, never
   * surfaced — the controller has already answered 202.
   */
  async ingest(dto: TrackBatchDto, tenantId = 'default'): Promise<void> {
    const receivedAt = Date.now();
    const fresh = await this.dropAlreadySeen(dto.events, tenantId);
    if (!fresh.length) return;

    const events: ITrackingEvent[] = fresh.map((e) => ({
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

  /**
   * Claims each event's `eventId` and returns only the ones not seen before.
   *
   * The claim is per tenant, and the key is set with NX so two concurrent
   * batches carrying the same event cannot both win. Redis being unavailable
   * degrades to accepting everything: over-counting on a retry is far less bad
   * than dropping real traffic, and the endpoint must stay up regardless.
   */
  private async dropAlreadySeen<T extends { eventId: string }>(
    events: T[],
    tenantId: string,
  ): Promise<T[]> {
    try {
      const pipeline = this.redis.multi();
      for (const e of events) {
        pipeline.set(
          trackingSeenKey(`${tenantId}:${e.eventId}`),
          '1',
          'EX',
          TRACKING_SEEN_TTL_SECONDS,
          'NX',
        );
      }
      const results = await pipeline.exec();
      const fresh = events.filter((_, i) => results?.[i]?.[1] === 'OK');
      const dropped = events.length - fresh.length;
      if (dropped > 0) {
        // Counted as well as logged: the debug log is invisible in production,
        // and a sudden spike means a client is retrying beacons.
        this.duplicatesDropped.inc(dropped);
        this.logger.debug(
          `Tracking ingest: dropped ${dropped} duplicate event(s)`,
        );
      }
      return fresh;
    } catch (err) {
      this.logger.warn(
        `Tracking dedup unavailable, accepting batch as-is: ${
          (err as Error).message
        }`,
      );
      return events;
    }
  }

  /** Dashboard aggregates, straight from ClickHouse (no cache — cheap queries). */
  async getInsights(
    days = TRACKING_INSIGHTS_DEFAULT_DAYS,
    tenantId = DEFAULT_TENANT,
  ): Promise<ITrackingInsights> {
    const window = days > 0 ? days : TRACKING_INSIGHTS_DEFAULT_DAYS;
    const [topPages, eventsByName, dailyUniques, recent, funnel] =
      await Promise.all([
        this.trackingRepo.getTopPages(window, tenantId),
        this.trackingRepo.getEventsByName(window, tenantId),
        this.trackingRepo.getDailyUniques(window, tenantId),
        this.trackingRepo.getRecent(tenantId),
        this.trackingRepo.getFunnel(window, tenantId),
      ]);
    return { topPages, eventsByName, dailyUniques, recent, funnel };
  }
}
