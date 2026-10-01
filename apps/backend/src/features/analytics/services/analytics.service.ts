import { Injectable, Inject } from '@nestjs/common';
import {
  DOCUMENTS,
  type DocumentsPort,
} from '../../../infrastructure/documents/documents.port';
import { randomUUID } from 'crypto';
import type { TenantId } from '../../../common/keyspace';
import {
  CACHE,
  type CachePort,
} from '../../../infrastructure/cache/cache.port';
import { EventLogRepository } from '../repositories/event-log.repository';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import { AnalyticsTransformer } from '../transformers/analytics.transformer';
import { CreateEventDto } from '../dto/create-event.dto';
import { IEventLog, IAnalyticsStats } from '../interfaces/analytics.interface';
import {
  ANALYTICS_EVENT_RECORDED,
  ANALYTICS_TOPIC,
  ANALYTICS_STATS_CACHE,
  ANALYTICS_CACHE_TTL_SEC,
} from '../constants/analytics.constants';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly eventLogRepo: EventLogRepository,
    private readonly analyticsRepo: AnalyticsRepository,
    private readonly outboxService: OutboxService,
    @Inject(DOCUMENTS) private readonly documents: DocumentsPort,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  // ── Create ─────────────────────────────────────────────────────────
  /**
   * Full event pipeline:
   *   1. Save EventLog + outbox entry in one MongoDB transaction (atomic, at-least-once)
   *   2. Outbox relay publishes to Pulsar  (AnalyticsProcessor → ClickHouse, Flink)
   *   3. Bust the stats cache              (next GET /stats fetches fresh from OLAP)
   *
   * Live delivery to browsers is handled downstream: AnalyticsProcessor broadcasts
   * over the WebSocket gateway once the event lands in ClickHouse.
   */
  async create(tenantId: TenantId, dto: CreateEventDto): Promise<IEventLog> {
    const eventId = randomUUID();
    const timestamp = Date.now();

    let doc: Awaited<ReturnType<typeof this.eventLogRepo.create>>;

    await this.documents.withTransaction(async (tx) => {
      doc = await this.eventLogRepo.create(
        tenantId,
        {
          eventId,
          eventType: dto.eventType,
          userId: dto.userId,
          metadata: dto.metadata ?? {},
          timestamp,
        },
        tx,
      );
      await this.outboxService.write(
        {
          topic: ANALYTICS_TOPIC,
          aggregateId: eventId,
          id: eventId,
          type: ANALYTICS_EVENT_RECORDED,
          tenantId,
          data: {
            eventId,
            eventType: dto.eventType,
            userId: dto.userId,
            metadata: dto.metadata ?? {},
            timestamp,
            tenantId,
          },
        },
        tx,
      );
    });

    const event = AnalyticsTransformer.toResponse(doc!);

    await this.cache.del(ANALYTICS_STATS_CACHE.forTenant(tenantId));

    return event;
  }

  // ── Stats (cached OLAP query) ──────────────────────────────────────
  /**
   * Read path:
   *   cache hit  → return immediately (fromCache: true)
   *   cache miss → query OLAP → cache 30s → return (fromCache: false)
   *
   * This is the classic cache-aside pattern — also called lazy caching.
   * The write path (create) invalidates the cache so reads are never stale > 30s.
   */
  async getStats(tenantId: TenantId): Promise<IAnalyticsStats> {
    const cacheKey = ANALYTICS_STATS_CACHE.forTenant(tenantId);
    const cached = await this.cache.get<IAnalyticsStats>(cacheKey);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    const from = Date.now() - 24 * 60 * 60 * 1000;
    const byType = await this.analyticsRepo.getStatsByType(from, tenantId);
    const total = byType.reduce((sum, r) => sum + r.count, 0);

    const stats: IAnalyticsStats = {
      totalEvents: total,
      byType,
      cachedAt: Date.now(),
      fromCache: false,
    };

    await this.cache.set(cacheKey, stats, ANALYTICS_CACHE_TTL_SEC);

    return stats;
  }

  // ── Recent events from MongoDB ─────────────────────────────────────
  async getRecent(tenantId: TenantId): Promise<IEventLog[]> {
    const docs = await this.eventLogRepo.findAll(tenantId, 20);
    return docs.map((doc) => AnalyticsTransformer.toResponse(doc));
  }

  async getMinutelyStats(tenantId: TenantId, minutes = 60) {
    return this.analyticsRepo.getMinutelyStats(minutes, tenantId);
  }
}
