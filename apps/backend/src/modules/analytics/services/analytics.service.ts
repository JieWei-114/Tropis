import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { randomUUID } from 'crypto';
import { Subject, Observable } from 'rxjs';
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

  // SSE Subject — every new event is pushed here and out to connected browser clients
  private readonly eventStream$ = new Subject<IEventLog>();

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
   *   4. Push to SSE Subject               (browser sees it instantly, no polling)
   */
  async create(dto: CreateEventDto): Promise<IEventLog> {
    const eventId = randomUUID();
    const timestamp = Date.now();
    const tenantId = dto.tenantId ?? 'default';

    const session = await this.connection.startSession();
    let doc: Awaited<ReturnType<typeof this.eventLogRepo.create>>;

    try {
      await session.withTransaction(async () => {
        doc = await this.eventLogRepo.createWithSession(
          {
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
    this.eventStream$.next(event);

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
  async getStats(tenantId = 'default'): Promise<IAnalyticsStats> {
    const cacheKey = analyticsStatsKey(tenantId);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { ...(JSON.parse(cached) as IAnalyticsStats), fromCache: true };
    }

    const from = Date.now() - 24 * 60 * 60 * 1000;
    const byType = await this.analyticsRepo.getStatsByType(from);
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
  async getRecent(): Promise<IEventLog[]> {
    const docs = await this.eventLogRepo.findAll(20);
    return docs.map((doc) => AnalyticsTransformer.toResponse(doc));
  }

  async getMinutelyStats(minutes = 60) {
    return this.analyticsRepo.getMinutelyStats(minutes);
  }

  // ── SSE Observable ─────────────────────────────────────────────────
  getEventStream(): Observable<IEventLog> {
    return this.eventStream$.asObservable();
  }
}
