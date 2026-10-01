import { Test, TestingModule } from '@nestjs/testing';
import { ANALYTICS_EVENT_TYPES } from '@tropis/shared';
import { DOCUMENTS } from '../../../infrastructure/documents/documents.port';
import { AnalyticsService } from '../services/analytics.service';
import { EventLogRepository } from '../repositories/event-log.repository';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { toTenantId } from '../../../common/keyspace';
import { CACHE } from '../../../infrastructure/cache/cache.port';
import {
  ANALYTICS_STATS_CACHE,
  ANALYTICS_EVENT_RECORDED,
  ANALYTICS_TOPIC,
} from '../constants/analytics.constants';

const statsKey = (tenant: string) =>
  ANALYTICS_STATS_CACHE.forTenant(toTenantId(tenant));
const AnalyticsEventType = ANALYTICS_EVENT_TYPES;

const mockEvent = {
  eventId: 'evt-1',
  eventType: 'page_view',
  userId: 'user-123',
  metadata: {},
  timestamp: Date.now(),
};

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let eventLogRepo: jest.Mocked<Pick<EventLogRepository, 'create' | 'findAll'>>;
  let analyticsRepo: jest.Mocked<Pick<AnalyticsRepository, 'getStatsByType'>>;
  let outboxService: { write: jest.Mock };
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  const tx = { tx: true };
  let documents: { withTransaction: jest.Mock };

  beforeEach(async () => {
    eventLogRepo = {
      create: jest.fn().mockResolvedValue(mockEvent),
      findAll: jest.fn().mockResolvedValue([mockEvent]),
    };

    analyticsRepo = {
      getStatsByType: jest
        .fn()
        .mockResolvedValue([{ type: 'page_view', count: 5 }]),
    };

    outboxService = { write: jest.fn().mockResolvedValue(undefined) };

    cache = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    documents = {
      withTransaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: EventLogRepository, useValue: eventLogRepo },
        { provide: AnalyticsRepository, useValue: analyticsRepo },
        { provide: OutboxService, useValue: outboxService },
        { provide: DOCUMENTS, useValue: documents },
        { provide: CACHE, useValue: cache },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  });

  describe('create', () => {
    it('persists event to MongoDB inside a transaction', async () => {
      await service.create(toTenantId('tenant-a'), {
        eventType: AnalyticsEventType.PAGE_VIEW,
        userId: 'user-123',
      });

      expect(documents.withTransaction).toHaveBeenCalled();
      expect(eventLogRepo.create).toHaveBeenCalledWith(
        'tenant-a',
        expect.objectContaining({ eventType: AnalyticsEventType.PAGE_VIEW }),
        tx,
      );
    });

    it('writes an outbox entry in the same transaction', async () => {
      await service.create(toTenantId('tenant-a'), {
        eventType: AnalyticsEventType.PAGE_VIEW,
        userId: 'user-123',
      });

      expect(outboxService.write).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: ANALYTICS_TOPIC,
          type: ANALYTICS_EVENT_RECORDED,
          tenantId: 'tenant-a',
          data: expect.objectContaining({
            userId: 'user-123',
            eventType: AnalyticsEventType.PAGE_VIEW,
            tenantId: 'tenant-a',
          }),
        }),
        tx,
      );
    });

    it('busts the tenant-scoped analytics cache after creating an event', async () => {
      await service.create(toTenantId('tenant-a'), {
        eventType: AnalyticsEventType.PAGE_VIEW,
        userId: 'user-123',
      });
      expect(cache.del).toHaveBeenCalledWith(statsKey('tenant-a'));
    });

    it('busts the cache for a custom tenant', async () => {
      await service.create(toTenantId('tenant-a'), {
        eventType: AnalyticsEventType.PAGE_VIEW,
        userId: 'user-123',
      });
      expect(cache.del).toHaveBeenCalledWith(statsKey('tenant-a'));
    });
  });

  describe('getStats', () => {
    it('filters the OLAP query by the same tenant it caches under', async () => {
      // The cache key was already per tenant while the query was not, so one
      // tenant's cache entry held the whole cluster's counts — a cross-tenant
      // leak, not merely a wrong total. The filter and the key must agree.
      await service.getStats(toTenantId('tenant-b'));

      expect(analyticsRepo.getStatsByType).toHaveBeenCalledWith(
        expect.any(Number),
        'tenant-b',
      );
      const [key] = cache.set.mock.calls[0] as [string];
      expect(key).toBe(statsKey('tenant-b'));
    });

    it('never serves one tenant a cache entry written for another', async () => {
      await service.getStats(toTenantId('tenant-a'));
      await service.getStats(toTenantId('tenant-b'));

      const keys = (cache.set.mock.calls as [string][]).map(([k]) => k);
      expect(new Set(keys).size).toBe(2);
    });

    it('returns cached stats when the cache has a value', async () => {
      const cached = { totalEvents: 3, byType: [], cachedAt: Date.now() };
      cache.get.mockResolvedValue(cached);

      const result = await service.getStats(toTenantId('tenant-a'));

      expect(cache.get).toHaveBeenCalledWith(statsKey('tenant-a'));
      expect(result.fromCache).toBe(true);
      expect(analyticsRepo.getStatsByType).not.toHaveBeenCalled();
    });

    it('queries OLAP on cache miss and caches the result', async () => {
      const result = await service.getStats(toTenantId('tenant-a'));

      expect(analyticsRepo.getStatsByType).toHaveBeenCalled();
      expect(cache.set).toHaveBeenCalledWith(
        statsKey('tenant-a'),
        expect.objectContaining({ totalEvents: 5 }),
        30,
      );
      expect(result.fromCache).toBe(false);
      expect(result.totalEvents).toBe(5);
    });

    it('uses a tenant-scoped cache key', async () => {
      await service.getStats(toTenantId('tenant-a'));

      expect(cache.get).toHaveBeenCalledWith(statsKey('tenant-a'));
      expect(cache.set).toHaveBeenCalledWith(
        statsKey('tenant-a'),
        expect.any(Object),
        30,
      );
    });
  });

  describe('getRecent', () => {
    it('scopes the query to the requested tenant', async () => {
      await service.getRecent(toTenantId('tenant-b'));
      expect(eventLogRepo.findAll).toHaveBeenCalledWith('tenant-b', 20);
    });

    it('returns the last 20 events from MongoDB', async () => {
      const result = await service.getRecent(toTenantId('tenant-a'));
      expect(eventLogRepo.findAll).toHaveBeenCalledWith('tenant-a', 20);
      expect(result).toHaveLength(1);
    });
  });
});
