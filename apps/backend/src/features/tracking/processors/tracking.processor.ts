import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import {
  EventConsumer,
  type ConsumerHandle,
} from '../../../infrastructure/messaging/event-consumer';
import {
  TRACKING_EVENT_WRITTEN,
  TRACKING_SEEN_TTL_SECONDS,
  TRACKING_SUBSCRIPTION,
  TRACKING_TOPIC,
} from '../constants/tracking.constants';
import type { ITrackingEvent } from '../interfaces/tracking.interface';
import { TrackingSinkService } from '../services/tracking-sink.service';

/**
 * Broker → OLAP sink for user-behavior batches:
 *   POST /api/v1/track → TrackingService.ingest() → "tracking-events"
 *     → here → logs.user_behavior
 *
 * Each message carries a whole client batch, so every receive is a natural
 * batch insert, for the envelope's tenant. Events naming another tenant or
 * no eventId are dropped; each remaining event is written once
 * (TRACKING_EVENT_WRITTEN), so a redelivered batch is not inserted twice.
 */
@Injectable()
export class TrackingProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('tracking');
  private subscription: ConsumerHandle | null = null;

  constructor(
    private readonly consumer: EventConsumer,
    private readonly sink: TrackingSinkService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.consumer.start<{ events?: ITrackingEvent[] }>({
      topic: TRACKING_TOPIC,
      subscription: TRACKING_SUBSCRIPTION,
      module: 'tracking',
      handle: ({ data, tenantId }) => this.handle(tenantId, data.events ?? []),
    });
  }

  async onModuleDestroy() {
    await this.subscription?.close();
  }

  private async handle(
    tenant: TenantId,
    batch: ITrackingEvent[],
  ): Promise<void> {
    const own = batch.filter((e) => !e.tenantId || e.tenantId === tenant);
    if (own.length < batch.length) {
      this.logger.warn(
        'events-tenant-mismatch',
        'Tracking events naming another tenant dropped',
        { 'tracking.events_dropped': batch.length - own.length },
      );
    }
    const withId = own.filter((e) => e.eventId);
    if (withId.length < own.length) {
      this.logger.warn(
        'event-id-missing',
        'Tracking events without eventId dropped',
        { 'tracking.events_dropped': own.length - withId.length },
      );
    }
    const written = await this.consumer.onceEach(
      withId,
      (e) => TRACKING_EVENT_WRITTEN.forTenant(tenant, e.eventId),
      (fresh) => this.sink.store(tenant, fresh),
      { seenTtlSeconds: TRACKING_SEEN_TTL_SECONDS },
    );
    if (written.length < withId.length) {
      this.logger.debug(
        'duplicates-skipped',
        'Already written tracking events skipped',
        { 'tracking.events_dropped': withId.length - written.length },
      );
    }
    if (written.length) await this.sink.notify(tenant, written.length);
  }
}
