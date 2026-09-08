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
import { NotificationGateway } from '../../websocket/gateways/notification.gateway';
import { IEventLog } from '../interfaces/analytics.interface';
import {
  ANALYTICS_TOPIC,
  ANALYTICS_SUBSCRIPTION,
} from '../constants/analytics.constants';
import type Redis from 'ioredis';
import { DEFAULT_TENANT } from '../../user/constants/user.enums';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';

/** Dedup marker per eventId — ClickHouse MergeTree does not deduplicate. */
const dedupKey = (eventId: string) => `analytics-processor:seen:${eventId}`;
const DEDUP_TTL_SECONDS = 24 * 60 * 60;
/** Held only while the insert runs; released on failure so a retry can proceed. */
/** Must stay below the broker ackTimeoutMs (60s) — see user.processor.ts. */
const DEDUP_IN_PROGRESS_SECONDS = 30;

/**
 * Envelope the outbox relay publishes. The business event is nested under
 * `payload`; the top-level `eventId` is the OUTBOX ROW id and `timestamp` is
 * the relay's publish time, neither of which is the event's own.
 */
interface OutboxEnvelope {
  eventId?: string;
  eventType?: string;
  aggregateId?: string;
  payload?: IEventLog & { tenantId?: string };
  timestamp?: number;
}

/**
 * Listens to the analytics topic and writes each event into ClickHouse.
 *
 * Flow:
 *   broker "analytics-events"
 *     → AnalyticsProcessor handler
 *       → unwrap the outbox envelope → AnalyticsRepository.insertEvent()
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
    private readonly gateway: NotificationGateway,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    try {
      this.subscription = await this.broker.subscribe(
        ANALYTICS_TOPIC,
        ANALYTICS_SUBSCRIPTION,
        (data) => this.handle(JSON.parse(data.toString()) as OutboxEnvelope),
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

  private async handle(envelope: OutboxEnvelope) {
    // Unwrap the relay envelope: the business fields live under `payload`,
    // while the envelope's own eventId is the outbox row id and its timestamp
    // is the relay's publish time. Reading the envelope directly yields rows
    // with no user_id, no payload, and the relay's clock as `ts`, and the same
    // object reaches the live feed.
    //
    // The `?? envelope` fallback covers a direct publish (no outbox), so this
    // handler stays correct for both producers.
    const event = (envelope.payload ??
      (envelope as unknown as IEventLog)) as IEventLog & {
      tenantId?: string;
    };
    const tenantId = event.tenantId ?? DEFAULT_TENANT;

    if (!event.eventId) {
      this.logger.warn(
        { envelopeEventId: envelope.eventId },
        'AnalyticsProcessor: message carries no eventId, dropping',
      );
      return;
    }

    // Idempotency, claim-then-commit. ClickHouse MergeTree does NOT dedupe, so
    // a redelivery (nack, ack timeout, relay lock expiry) would insert the
    // event again and inflate every count. Keyed on the DOMAIN eventId: the
    // outbox row id is unique per delivery attempt and dedupes nothing.
    const claimKey = dedupKey(event.eventId);
    const claimed = await this.redis.set(
      claimKey,
      '1',
      'EX',
      DEDUP_IN_PROGRESS_SECONDS,
      'NX',
    );
    if (claimed !== 'OK') {
      this.logger.debug(
        { eventId: event.eventId },
        'AnalyticsProcessor: duplicate event skipped',
      );
      return;
    }

    try {
      await this.analyticsRepo.insertEvent({
        tenant_id: tenantId,
        event_id: event.eventId,
        event_type: event.eventType,
        user_id: event.userId,
        payload: JSON.stringify(event.metadata ?? {}),
        ts: event.timestamp,
      });
      await this.redis.expire(claimKey, DEDUP_TTL_SECONDS);
      this.logger.info(
        { eventId: event.eventId, eventType: event.eventType },
        'AnalyticsProcessor: wrote to ClickHouse',
      );
    } catch (err) {
      // Release the claim so the redelivery can retry, then rethrow so the
      // broker nacks (and eventually dead-letters) instead of acknowledging.
      await this.redis
        .del(claimKey)
        .catch((e: Error) =>
          this.logger.error(
            `Failed to release dedup claim ${claimKey}: ${e.message}`,
          ),
        );
      throw err;
    }

    // Cosmetic live-feed push, deliberately outside the retry path: a throw
    // here would have the message redelivered and the row re-inserted.
    try {
      this.gateway.broadcast('analytics.event', event);
    } catch (err) {
      this.logger.warn(
        `Live-feed broadcast failed (event stored): ${(err as Error).message}`,
      );
    }
  }
}
