import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import * as jwt from 'jsonwebtoken';
import { GrpcAnalyticsService } from '../controllers/analytics.grpc.controller';
import { AnalyticsService } from '../services/analytics.service';
import { AnalyticsEventType } from '../constants/analytics.enums';
import { IEventLog, IAnalyticsStats } from '../interfaces/analytics.interface';
import { GrpcAuthzService } from '../../../infrastructure/grpc/grpc-authz.service';
import { OpaService } from '../../../infrastructure/opa/opa.service';

const JWT_SECRET = 'test-secret';

/** Metadata carrying a signed token for `tenantId`. */
const authMeta = (tenantId = 'tenant-a') => {
  const token = jwt.sign({ sub: 'user-1', tenantId }, JWT_SECRET);
  return {
    get: (k: string) => (k === 'authorization' ? [`Bearer ${token}`] : []),
  };
};

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
  let opa: { allow: jest.Mock };

  beforeEach(async () => {
    analyticsService = {
      create: jest.fn(),
      getStats: jest.fn(),
      getRecent: jest.fn(),
      getMinutelyStats: jest.fn(),
    } as unknown as jest.Mocked<AnalyticsService>;
    opa = { allow: jest.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GrpcAnalyticsService,
        GrpcAuthzService,
        { provide: AnalyticsService, useValue: analyticsService },
        { provide: OpaService, useValue: opa },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => JWT_SECRET },
        },
      ],
    }).compile();

    service = module.get(GrpcAnalyticsService);
  });

  // ── Authorization ────────────────────────────────────────────────────────
  //
  // Every method must demand a verified token and an OPA decision. An
  // unauthorized method lets anyone on the network read event rows (with
  // userIds and metadata) and inject events into the pipeline.

  describe('authorization', () => {
    const callsWithoutToken: [string, () => Promise<unknown>][] = [
      [
        'createEvent',
        () =>
          service.createEvent(
            { event_type: 'page_view', user_id: 'u1' },
            undefined,
          ),
      ],
      ['getStats', () => service.getStats({}, undefined)],
      ['getRecent', () => service.getRecent({}, undefined)],
      ['getMinutelyStats', () => service.getMinutelyStats({}, undefined)],
    ];

    it.each(callsWithoutToken)('%s rejects an absent token', async (_n, fn) => {
      await expect(fn()).rejects.toThrow(RpcException);
      expect(analyticsService.create).not.toHaveBeenCalled();
      expect(analyticsService.getStats).not.toHaveBeenCalled();
      expect(analyticsService.getRecent).not.toHaveBeenCalled();
      expect(analyticsService.getMinutelyStats).not.toHaveBeenCalled();
    });

    it('rejects an unverifiable token instead of falling back to the default tenant', async () => {
      const metadata = {
        get: (k: string) => (k === 'authorization' ? ['Bearer garbage'] : []),
      };

      await expect(service.getStats({}, metadata)).rejects.toMatchObject({
        error: { code: GrpcStatus.UNAUTHENTICATED },
      });
      expect(analyticsService.getStats).not.toHaveBeenCalled();
    });

    it('rejects a valid token whose role OPA denies', async () => {
      opa.allow.mockResolvedValue(false);

      await expect(service.getStats({}, authMeta())).rejects.toMatchObject({
        error: { code: GrpcStatus.PERMISSION_DENIED },
      });
    });

    it('asks OPA for `write` on createEvent and `read` on the queries', async () => {
      analyticsService.create.mockResolvedValue(mockEvent());
      analyticsService.getStats.mockResolvedValue(mockStats());

      await service.createEvent(
        { event_type: 'page_view', user_id: 'u1' },
        authMeta(),
      );
      expect(opa.allow).toHaveBeenCalledWith(
        expect.objectContaining({ resource: 'analytics', action: 'write' }),
      );

      await service.getStats({}, authMeta());
      expect(opa.allow).toHaveBeenCalledWith(
        expect.objectContaining({ resource: 'analytics', action: 'read' }),
      );
    });
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
        authMeta(),
      );

      expect(analyticsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'page_view',
          userId: 'user-123',
          metadata: { page: '/home' },
          tenantId: 'tenant-a',
        }),
      );
      expect(res.event_id).toBe('evt-123');
      expect(res.event_type).toBe('page_view');
    });

    it('handles missing metadata gracefully', async () => {
      analyticsService.create.mockResolvedValue(mockEvent());

      await service.createEvent(
        { event_type: 'page_view', user_id: 'user-123' },
        authMeta(),
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
        { event_type: 'page_view', user_id: 'user-123' },
        authMeta(),
      );

      expect(typeof res.metadata).toBe('string');
      expect(JSON.parse(res.metadata)).toEqual({ page: '/about' });
    });
  });

  // ── GetStats ─────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('maps stats to gRPC shape', async () => {
      analyticsService.getStats.mockResolvedValue(mockStats());

      const res = await service.getStats({}, authMeta());

      expect(res.total_events).toBe(42);
      expect(res.by_type).toHaveLength(2);
      expect(res.by_type[0].event_type).toBe('page_view');
      expect(res.by_type[0].count).toBe(30);
      expect(res.from_cache).toBe(false);
    });

    it('scopes stats to the tenant in the verified token', async () => {
      analyticsService.getStats.mockResolvedValue(mockStats());

      await service.getStats({}, authMeta('tenant-b'));

      expect(analyticsService.getStats).toHaveBeenCalledWith('tenant-b');
    });
  });

  // ── GetRecent ────────────────────────────────────────────────────────────

  describe('getRecent', () => {
    it('returns list of recent events', async () => {
      analyticsService.getRecent.mockResolvedValue([
        mockEvent(),
        mockEvent({ eventId: 'evt-456' }),
      ]);

      const res = await service.getRecent({}, authMeta());

      expect(res.events).toHaveLength(2);
      expect(res.events[0].event_id).toBe('evt-123');
      expect(res.events[1].event_id).toBe('evt-456');
    });

    it('returns empty list when no events', async () => {
      analyticsService.getRecent.mockResolvedValue([]);

      const res = await service.getRecent({}, authMeta());

      expect(res.events).toEqual([]);
    });

    it('scopes the live feed to the tenant in the verified token', async () => {
      analyticsService.getRecent.mockResolvedValue([]);

      await service.getRecent({}, authMeta('tenant-b'));

      expect(analyticsService.getRecent).toHaveBeenCalledWith('tenant-b');
    });
  });

  // ── GetMinutelyStats ─────────────────────────────────────────────────────

  describe('getMinutelyStats', () => {
    it('maps minutely rows to gRPC shape', async () => {
      analyticsService.getMinutelyStats.mockResolvedValue([
        { windowMs: 1700000000000, eventType: 'page_view', count: 5 },
        { windowMs: 1700000060000, eventType: 'page_view', count: 8 },
      ]);

      const res = await service.getMinutelyStats({ minutes: 30 }, authMeta());

      expect(res.stats).toHaveLength(2);
      expect(res.stats[0].window_ms).toBe(1700000000000);
      expect(res.stats[0].count).toBe(5);
      expect(analyticsService.getMinutelyStats).toHaveBeenCalledWith(
        30,
        'tenant-a',
      );
    });

    it('defaults to 60 minutes', async () => {
      analyticsService.getMinutelyStats.mockResolvedValue([]);

      await service.getMinutelyStats({}, authMeta());

      expect(analyticsService.getMinutelyStats).toHaveBeenCalledWith(
        60,
        'tenant-a',
      );
    });

    it('clamps an unbounded window to 24h', async () => {
      analyticsService.getMinutelyStats.mockResolvedValue([]);

      await service.getMinutelyStats({ minutes: 100_000 }, authMeta());

      expect(analyticsService.getMinutelyStats).toHaveBeenCalledWith(
        24 * 60,
        'tenant-a',
      );
    });
  });
});
