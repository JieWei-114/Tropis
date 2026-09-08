import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { AnalyticsService } from '../services/analytics.service';
import { EventLogRepository } from '../repositories/event-log.repository';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import {
  analyticsStatsKey,
  ANALYTICS_TOPIC,
} from '../constants/analytics.constants';
import { AnalyticsEventType } from '../schemas/event-log.schema';

const mockEvent = {
  eventId: 'evt-1',
  eventType: 'page_view',
  userId: 'user-123',
  metadata: {},
  timestamp: Date.now(),
};

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let eventLogRepo: jest.Mocked<
    Pick<EventLogRepository, 'createWithSession' | 'findAll'>
  >;
  let analyticsRepo: jest.Mocked<Pick<AnalyticsRepository, 'getStatsByType'>>;
  let outboxService: { write: jest.Mock };
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let session: { withTransaction: jest.Mock; endSession: jest.Mock };

  beforeEach(async () => {
    eventLogRepo = {
      createWithSession: jest.fn().mockResolvedValue(mockEvent),
      findAll: jest.fn().mockResolvedValue([mockEvent]),
    };

    analyticsRepo = {
      getStatsByType: jest
        .fn()
        .mockResolvedValue([{ type: 'page_view', count: 5 }]),
    };

    outboxService = { write: jest.fn().mockResolvedValue(undefined) };

    redis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    session = {
      withTransaction: jest.fn(async (fn: () => Promise<void>) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };

    const connection = {
      startSession: jest.fn().mockResolvedValue(session),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: EventLogRepository, useValue: eventLogRepo },
        { provide: AnalyticsRepository, useValue: analyticsRepo },
        { provide: OutboxService, useValue: outboxService },
        { provide: getConnectionToken(), useValue: connection },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  });

  describe('create', () => {
    it('persists event to MongoDB inside a transaction', async () => {
      await service.create({
        eventType: AnalyticsEventType.PAGE_VIEW,
        userId: 'user-123',
      });

      expect(session.withTransaction).toHaveBeenCalled();
      expect(eventLogRepo.createWithSession).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: AnalyticsEventType.PAGE_VIEW }),
        session,
      );
      expect(session.endSession).toHaveBeenCalled();
    });

    it('writes an outbox entry in the same transaction', async () => {
      await service.create({
        eventType: AnalyticsEventType.PAGE_VIEW,
        userId: 'user-123',
        tenantId: 'tenant-a',
      });

      expect(outboxService.write).toHaveBeenCalledWith(
        expect.any(String),
        AnalyticsEventType.PAGE_VIEW,
        expect.objectContaining({ userId: 'user-123', tenantId: 'tenant-a' }),
        session,
        ANALYTICS_TOPIC,
      );
    });

    it('busts the tenant-scoped analytics cache after creating an event', async () => {
      await service.create({
        eventType: AnalyticsEventType.PAGE_VIEW,
        userId: 'user-123',
      });
      expect(redis.del).toHaveBeenCalledWith(analyticsStatsKey('default'));
    });

    it('busts the cache for a custom tenant', async () => {
      await service.create({
        eventType: AnalyticsEventType.PAGE_VIEW,
        userId: 'user-123',
        tenantId: 'tenant-a',
      });
      expect(redis.del).toHaveBeenCalledWith(analyticsStatsKey('tenant-a'));
    });
  });

  describe('getStats', () => {
    it('filters the ClickHouse query by the same tenant it caches under', async () => {
      // The cache key was already per tenant while the query was not, so one
      // tenant's cache entry held the whole cluster's counts — a cross-tenant
      // leak, not merely a wrong total. The filter and the key must agree.
      redis.get.mockResolvedValue(null);

      await service.getStats('tenant-b');

      expect(analyticsRepo.getStatsByType).toHaveBeenCalledWith(
        expect.any(Number),
        'tenant-b',
      );
      const [key] = redis.set.mock.calls[0] as [string];
      expect(key).toContain('tenant-b');
    });

    it('never serves one tenant a cache entry written for another', async () => {
      redis.get.mockResolvedValue(null);

      await service.getStats('tenant-a');
      await service.getStats('tenant-b');

      const keys = (redis.set.mock.calls as [string][]).map(([k]) => k);
      expect(new Set(keys).size).toBe(2);
    });

    it('returns cached stats when Redis has a value', async () => {
      const cached = { totalEvents: 3, byType: [], cachedAt: Date.now() };
      redis.get.mockResolvedValue(JSON.stringify(cached));

      const result = await service.getStats();

      expect(redis.get).toHaveBeenCalledWith(analyticsStatsKey('default'));
      expect(result.fromCache).toBe(true);
      expect(analyticsRepo.getStatsByType).not.toHaveBeenCalled();
    });

    it('queries ClickHouse on cache miss and caches the result', async () => {
      redis.get.mockResolvedValue(null);

      const result = await service.getStats();

      expect(analyticsRepo.getStatsByType).toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalledWith(
        analyticsStatsKey('default'),
        expect.any(String),
        'EX',
        expect.any(Number),
      );
      expect(result.fromCache).toBe(false);
      expect(result.totalEvents).toBe(5);
    });

    it('uses a tenant-scoped cache key', async () => {
      redis.get.mockResolvedValue(null);

      await service.getStats('tenant-a');

      expect(redis.get).toHaveBeenCalledWith(analyticsStatsKey('tenant-a'));
      expect(redis.set).toHaveBeenCalledWith(
        analyticsStatsKey('tenant-a'),
        expect.any(String),
        'EX',
        expect.any(Number),
      );
    });
  });

  describe('getRecent', () => {
    it('scopes the query to the requested tenant', async () => {
      await service.getRecent('tenant-b');
      expect(eventLogRepo.findAll).toHaveBeenCalledWith(20, 'tenant-b');
    });

    it('returns the last 20 events from MongoDB', async () => {
      const result = await service.getRecent();
      expect(eventLogRepo.findAll).toHaveBeenCalledWith(20, 'default');
      expect(result).toHaveLength(1);
    });
  });
});
