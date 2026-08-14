import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { GrpcAnalyticsService } from '../controllers/analytics.grpc.controller';
import { AnalyticsService } from '../services/analytics.service';
import { AnalyticsEventType } from '../schemas/event-log.schema';
import { IEventLog, IAnalyticsStats } from '../interfaces/analytics.interface';

const JWT_SECRET = 'test-secret';

const mockEvent = (overrides = {}): IEventLog => ({
  eventId: 'evt-123',
  eventType: AnalyticsEventType.PAGE_VIEW,
  userId: 'user-123',
  metadata: { page: '/home' },
  timestamp: 1700000000000,
  ...overrides,
});

const mockStats = (): IAnalyticsStats => ({
  totalEvents: 42,
  byType: [
    {
      eventType: AnalyticsEventType.PAGE_VIEW,
      count: 30,
      lastSeen: 1700000000000,
    },
    {
      eventType: AnalyticsEventType.BUTTON_CLICK,
      count: 12,
      lastSeen: 1700000001000,
    },
  ],
  cachedAt: 1700000000000,
  fromCache: false,
});

describe('GrpcAnalyticsService', () => {
  let service: GrpcAnalyticsService;
  let analyticsService: jest.Mocked<AnalyticsService>;

  beforeEach(async () => {
    analyticsService = {
      create: jest.fn(),
      getStats: jest.fn(),
      getRecent: jest.fn(),
      getMinutelyStats: jest.fn(),
    } as unknown as jest.Mocked<AnalyticsService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GrpcAnalyticsService,
        { provide: AnalyticsService, useValue: analyticsService },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => JWT_SECRET },
        },
      ],
    }).compile();

    service = module.get(GrpcAnalyticsService);
  });

  // ── CreateEvent ──────────────────────────────────────────────────────────

  describe('createEvent', () => {
    it('parses metadata JSON and delegates to AnalyticsService', async () => {
      analyticsService.create.mockResolvedValue(mockEvent());

      const res = await service.createEvent(
        {
          event_type: 'page_view',
          user_id: 'user-123',
          metadata: '{"page":"/home"}',
        },
        undefined,
      );

      expect(analyticsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'page_view',
          userId: 'user-123',
          metadata: { page: '/home' },
          tenantId: 'default',
        }),
      );
      expect(res.event_id).toBe('evt-123');
      expect(res.event_type).toBe('page_view');
    });

    it('handles missing metadata gracefully', async () => {
      analyticsService.create.mockResolvedValue(mockEvent());

      await service.createEvent(
        {
          event_type: 'page_view',
          user_id: 'user-123',
        },
        undefined,
      );

      expect(analyticsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: {} }),
      );
    });

    it('serialises metadata back to JSON string in response', async () => {
      analyticsService.create.mockResolvedValue(
        mockEvent({ metadata: { page: '/about' } }),
      );

      const res = await service.createEvent(
        {
          event_type: 'page_view',
          user_id: 'user-123',
        },
        undefined,
      );

      expect(typeof res.metadata).toBe('string');
      expect(JSON.parse(res.metadata)).toEqual({ page: '/about' });
    });
  });

  // ── GetStats ─────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('maps stats to gRPC shape', async () => {
      analyticsService.getStats.mockResolvedValue(mockStats());

      const res = await service.getStats({}, undefined);

      expect(res.total_events).toBe(42);
      expect(res.by_type).toHaveLength(2);
      expect(res.by_type[0].event_type).toBe('page_view');
      expect(res.by_type[0].count).toBe(30);
      expect(res.from_cache).toBe(false);
      expect(analyticsService.getStats).toHaveBeenCalledWith('default');
    });

    it('resolves tenantId from a valid JWT in the authorization metadata', async () => {
      analyticsService.getStats.mockResolvedValue(mockStats());
      const token = jwt.sign({ tenantId: 'tenant-a' }, JWT_SECRET);
      const metadata = {
        get: (k: string) => (k === 'authorization' ? [`Bearer ${token}`] : []),
      };

      await service.getStats({}, metadata);

      expect(analyticsService.getStats).toHaveBeenCalledWith('tenant-a');
    });

    it('falls back to default tenant on invalid token', async () => {
      analyticsService.getStats.mockResolvedValue(mockStats());
      const metadata = {
        get: (k: string) => (k === 'authorization' ? ['Bearer garbage'] : []),
      };

      await service.getStats({}, metadata);

      expect(analyticsService.getStats).toHaveBeenCalledWith('default');
    });
  });

  // ── GetRecent ────────────────────────────────────────────────────────────

  describe('getRecent', () => {
    it('returns list of recent events', async () => {
      analyticsService.getRecent.mockResolvedValue([
        mockEvent(),
        mockEvent({ eventId: 'evt-456' }),
      ]);

      const res = await service.getRecent({});

      expect(res.events).toHaveLength(2);
      expect(res.events[0].event_id).toBe('evt-123');
      expect(res.events[1].event_id).toBe('evt-456');
    });

    it('returns empty list when no events', async () => {
      analyticsService.getRecent.mockResolvedValue([]);

      const res = await service.getRecent({});

      expect(res.events).toEqual([]);
    });
  });

  // ── GetMinutelyStats ─────────────────────────────────────────────────────

  describe('getMinutelyStats', () => {
    it('maps minutely rows to gRPC shape', async () => {
      analyticsService.getMinutelyStats.mockResolvedValue([
        { windowMs: 1700000000000, eventType: 'page_view', count: 5 },
        { windowMs: 1700000060000, eventType: 'page_view', count: 8 },
      ]);

      const res = await service.getMinutelyStats({ minutes: 30 });

      expect(res.stats).toHaveLength(2);
      expect(res.stats[0].window_ms).toBe(1700000000000);
      expect(res.stats[0].count).toBe(5);
      expect(analyticsService.getMinutelyStats).toHaveBeenCalledWith(30);
    });

    it('defaults to 60 minutes', async () => {
      analyticsService.getMinutelyStats.mockResolvedValue([]);

      await service.getMinutelyStats({});

      expect(analyticsService.getMinutelyStats).toHaveBeenCalledWith(60);
    });
  });
});
