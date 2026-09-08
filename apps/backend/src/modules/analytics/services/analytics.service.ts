import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { randomUUID } from 'crypto';
import { DEFAULT_TENANT } from '../../user/constants/user.enums';
import type Redis from 'ioredis';
import { EventLogRepository } from '../repositories/event-log.repository';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import { AnalyticsTransformer } from '../transformers/analytics.transformer';
import { CreateEventDto } from '../dto/create-event.dto';
import { IEventLog, IAnalyticsStats } from '../interfaces/analytics.interface';
import {
  ANALYTICS_TOPIC,
  analyticsStatsKey,
  ANALYTICS_CACHE_TTL_SEC,
} from '../constants/analytics.constants';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly eventLogRepo: EventLogRepository,
    private readonly analyticsRepo: AnalyticsRepository,
    private readonly outboxService: OutboxService,
    @InjectConnection() private readonly connection: Connection,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ── Create ─────────────────────────────────────────────────────────
  /**
   * Full event pipeline:
   *   1. Save EventLog + outbox entry in one MongoDB transaction (atomic, at-least-once)
   *   2. Outbox relay publishes to Pulsar  (AnalyticsProcessor → ClickHouse, Flink)
   *   3. Bust Redis stats cache            (next GET /stats fetches fresh from ClickHouse)
   *
   * Live delivery to browsers is handled downstream: AnalyticsProcessor broadcasts
   * over the WebSocket gateway once the event lands in ClickHouse.
   */
  async create(dto: CreateEventDto): Promise<IEventLog> {
    const eventId = randomUUID();
    const timestamp = Date.now();
    const tenantId = dto.tenantId ?? DEFAULT_TENANT;

    const session = await this.connection.startSession();
    let doc: Awaited<ReturnType<typeof this.eventLogRepo.create>>;

    try {
      await session.withTransaction(async () => {
        doc = await this.eventLogRepo.createWithSession(
          {
            tenantId,
            eventId,
            eventType: dto.eventType,
            userId: dto.userId,
            metadata: dto.metadata ?? {},
            timestamp,
          },
          session,
        );
        await this.outboxService.write(
          eventId,
          dto.eventType,
          {
            eventId,
            eventType: dto.eventType,
            userId: dto.userId,
            metadata: dto.metadata ?? {},
            timestamp,
            tenantId,
          },
          session,
          ANALYTICS_TOPIC,
        );
      });
    } finally {
      await session.endSession();
    }

    const event = AnalyticsTransformer.toResponse(doc!);

    await this.redis.del(analyticsStatsKey(tenantId));

    return event;
  }

  // ── Stats (Redis-cached ClickHouse query) ──────────────────────────
  /**
   * Read path:
   *   Redis hit  → return immediately (fromCache: true)
   *   Redis miss → query ClickHouse → cache 30s → return (fromCache: false)
   *
   * This is the classic cache-aside pattern — also called lazy caching.
   * The write path (create) invalidates the cache so reads are never stale > 30s.
   */
  async getStats(tenantId = DEFAULT_TENANT): Promise<IAnalyticsStats> {
    const cacheKey = analyticsStatsKey(tenantId);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { ...(JSON.parse(cached) as IAnalyticsStats), fromCache: true };
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

    await this.redis.set(
      cacheKey,
      JSON.stringify(stats),
      'EX',
      ANALYTICS_CACHE_TTL_SEC,
    );

    return stats;
  }

  // ── Recent events from MongoDB ─────────────────────────────────────
  async getRecent(tenantId = DEFAULT_TENANT): Promise<IEventLog[]> {
    const docs = await this.eventLogRepo.findAll(20, tenantId);
    return docs.map((doc) => AnalyticsTransformer.toResponse(doc));
  }

  async getMinutelyStats(minutes = 60, tenantId = DEFAULT_TENANT) {
    return this.analyticsRepo.getMinutelyStats(minutes, tenantId);
  }
}
