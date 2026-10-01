import { Test, TestingModule } from '@nestjs/testing';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect';
import { AnalyticsRpcController } from '../controllers/analytics.rpc.controller';
import { AnalyticsService } from '../services/analytics.service';
import { ANALYTICS_EVENT_TYPES as AnalyticsEventType } from '@tropis/shared';
import { IEventLog, IAnalyticsStats } from '../interfaces/analytics.interface';
import { RpcAuthzService } from '../../../infrastructure/rpc/rpc-authz.service';
import {
  bearer,
  rpcContextFor,
  withAuthorization,
  type RpcCalls,
} from '../../../infrastructure/rpc/testing/rpc-test-context';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { TOKEN_VERIFIER } from '../../../common/auth/token-verifier.port';
import {
  credentialsFor,
  signAccessToken,
} from '../../../modules/auth/__tests__/token-fixtures';
import { POLICY } from '../../../infrastructure/policy/policy.port';
import {
  CreateEventRequestSchema,
  MinutelyStatsRequestSchema,
  RecentRequestSchema,
  StatsRequestSchema,
} from '../../../gen/analytics/v1/analytics_pb';

const tokenFor = (tenantId = 'tenant-a') =>
  signAccessToken({ sub: 'user-1', tenantId });

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

const stats = create(StatsRequestSchema);
const recent = create(RecentRequestSchema);
const event = (fields = {}) =>
  create(CreateEventRequestSchema, {
    eventType: 'page_view',
    userId: 'user-123',
    ...fields,
  });

describe('AnalyticsRpcController', () => {
  let controller: RpcCalls<AnalyticsRpcController>;
  let authz: RpcAuthzService;
  let analyticsService: jest.Mocked<AnalyticsService>;
  let opa: { allow: jest.Mock };

  const ctx = (headers: Record<string, string> = bearer(tokenFor())) =>
    rpcContextFor(
      credentialsFor(headers.authorization?.replace(/^Bearer /, '')),
      headers,
    );

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
        AnalyticsRpcController,
        RpcAuthzService,
        AuthorizationService,
        { provide: AnalyticsService, useValue: analyticsService },
        { provide: POLICY, useValue: opa },
        { provide: TOKEN_VERIFIER, useValue: {} },
      ],
    }).compile();

    controller = withAuthorization(
      module.get(AnalyticsRpcController),
      module.get(AuthorizationService),
    );
    authz = module.get(RpcAuthzService);
  });

  // ── Authorization ────────────────────────────────────────────────────────
  //
  // Every method must demand a verified token and an OPA decision. An
  // unauthorized method lets anyone on the network read event rows (with
  // userIds and metadata) and inject events into the pipeline.

  describe('authorization', () => {
    const callsWithoutToken: [
      string,
      (
        c: RpcCalls<AnalyticsRpcController>,
        x: HandlerContext,
      ) => Promise<unknown>,
    ][] = [
      ['createEvent', (c, x) => c.createEvent(event(), x)],
      ['getStats', (c, x) => c.getStats(stats, x)],
      ['getRecent', (c, x) => c.getRecent(recent, x)],
      [
        'getMinutelyStats',
        (c, x) => c.getMinutelyStats(create(MinutelyStatsRequestSchema), x),
      ],
    ];

    it.each(callsWithoutToken)('%s rejects an absent token', async (_n, fn) => {
      await expect(fn(controller, ctx({}))).rejects.toMatchObject({
        code: Code.Unauthenticated,
      });
      expect(analyticsService.create).not.toHaveBeenCalled();
      expect(analyticsService.getStats).not.toHaveBeenCalled();
      expect(analyticsService.getRecent).not.toHaveBeenCalled();
      expect(analyticsService.getMinutelyStats).not.toHaveBeenCalled();
    });

    it('rejects an unverifiable token instead of falling back to the default tenant', async () => {
      await expect(
        controller.getStats(stats, ctx(bearer('garbage'))),
      ).rejects.toMatchObject({ code: Code.Unauthenticated });
      expect(analyticsService.getStats).not.toHaveBeenCalled();
    });

    it('rejects a valid token whose role OPA denies', async () => {
      opa.allow.mockResolvedValue(false);

      const err = await controller
        .getStats(stats, ctx())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.PermissionDenied);
    });

    it('asks OPA for `write` on createEvent and `read` on the queries', async () => {
      analyticsService.create.mockResolvedValue(mockEvent());
      analyticsService.getStats.mockResolvedValue(mockStats());

      await controller.createEvent(event(), ctx());
      expect(opa.allow).toHaveBeenCalledWith(
        expect.objectContaining({ resource: 'analytics', action: 'write' }),
      );

      await controller.getStats(stats, ctx());
      expect(opa.allow).toHaveBeenCalledWith(
        expect.objectContaining({ resource: 'analytics', action: 'read' }),
      );
    });
  });

  // ── CreateEvent ──────────────────────────────────────────────────────────

  describe('createEvent', () => {
    it('parses metadata JSON and delegates to AnalyticsService', async () => {
      analyticsService.create.mockResolvedValue(mockEvent());

      const res = await controller.createEvent(
        event({ metadata: '{"page":"/home"}' }),
        ctx(),
      );

      expect(analyticsService.create).toHaveBeenCalledWith(
        'tenant-a',
        expect.objectContaining({
          eventType: 'page_view',
          userId: 'user-123',
          metadata: { page: '/home' },
        }),
      );
      expect(res.eventId).toBe('evt-123');
      expect(res.eventType).toBe('page_view');
      expect(res.timestamp).toBe(1700000000000n);
    });

    // Reproduces the gap: an unknown event type was cast through, and
    // metadata that was not JSON threw from JSON.parse and answered INTERNAL.
    it.each([
      ['an unknown event type', { eventType: 'drop_table' }, 'event_type'],
      ['metadata that is not JSON', { metadata: '{not json' }, 'metadata'],
      ['metadata that is not an object', { metadata: '[1,2]' }, 'metadata'],
    ])(
      'rejects %s with INVALID_ARGUMENT before the service runs',
      async (_label, extra, _field) => {
        const err = await controller
          .createEvent(event(extra), ctx())
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConnectError);
        expect((err as ConnectError).code).toBe(Code.InvalidArgument);
        expect(analyticsService.create).not.toHaveBeenCalled();
      },
    );

    it('handles missing metadata gracefully', async () => {
      analyticsService.create.mockResolvedValue(mockEvent());

      await controller.createEvent(event(), ctx());

      expect(analyticsService.create).toHaveBeenCalledWith(
        'tenant-a',
        expect.objectContaining({ metadata: {} }),
      );
    });

    it('serialises metadata back to a JSON string in the response', async () => {
      analyticsService.create.mockResolvedValue(
        mockEvent({ metadata: { page: '/about' } }),
      );

      const res = await controller.createEvent(event(), ctx());

      expect(typeof res.metadata).toBe('string');
      expect(JSON.parse(res.metadata as string)).toEqual({ page: '/about' });
    });
  });

  // ── GetStats ─────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('maps stats to the contract shape', async () => {
      analyticsService.getStats.mockResolvedValue(mockStats());

      const res = await controller.getStats(stats, ctx());

      expect(res.totalEvents).toBe(42);
      expect(res.byType).toHaveLength(2);
      expect(res.byType?.[0].eventType).toBe('page_view');
      expect(res.byType?.[0].count).toBe(30);
      expect(res.byType?.[0].lastSeen).toBe(1700000000000n);
      expect(res.fromCache).toBe(false);
    });

    it('scopes stats to the tenant in the verified token', async () => {
      analyticsService.getStats.mockResolvedValue(mockStats());

      await controller.getStats(stats, ctx(bearer(tokenFor('tenant-b'))));

      expect(analyticsService.getStats).toHaveBeenCalledWith('tenant-b');
    });
  });

  // ── GetRecent ────────────────────────────────────────────────────────────

  describe('getRecent', () => {
    it('returns the list of recent events', async () => {
      analyticsService.getRecent.mockResolvedValue([
        mockEvent(),
        mockEvent({ eventId: 'evt-456' }),
      ]);

      const res = await controller.getRecent(recent, ctx());

      expect(res.events).toHaveLength(2);
      expect(res.events?.[0].eventId).toBe('evt-123');
      expect(res.events?.[1].eventId).toBe('evt-456');
    });

    it('returns an empty list when there are no events', async () => {
      analyticsService.getRecent.mockResolvedValue([]);

      const res = await controller.getRecent(recent, ctx());

      expect(res.events).toEqual([]);
    });

    it('scopes the live feed to the tenant in the verified token', async () => {
      analyticsService.getRecent.mockResolvedValue([]);

      await controller.getRecent(recent, ctx(bearer(tokenFor('tenant-b'))));

      expect(analyticsService.getRecent).toHaveBeenCalledWith('tenant-b');
    });
  });

  // ── GetMinutelyStats ─────────────────────────────────────────────────────

  describe('getMinutelyStats', () => {
    const minutely = (minutes?: number) =>
      create(MinutelyStatsRequestSchema, minutes ? { minutes } : {});

    it('maps minutely rows to the contract shape', async () => {
      analyticsService.getMinutelyStats.mockResolvedValue([
        { windowMs: 1700000000000, eventType: 'page_view', count: 5 },
        { windowMs: 1700000060000, eventType: 'page_view', count: 8 },
      ]);

      const res = await controller.getMinutelyStats(minutely(30), ctx());

      expect(res.stats).toHaveLength(2);
      expect(res.stats?.[0].windowMs).toBe(1700000000000n);
      expect(res.stats?.[0].count).toBe(5);
      expect(analyticsService.getMinutelyStats).toHaveBeenCalledWith(
        'tenant-a',
        30,
      );
    });

    it('defaults to 60 minutes', async () => {
      analyticsService.getMinutelyStats.mockResolvedValue([]);

      await controller.getMinutelyStats(minutely(), ctx());

      expect(analyticsService.getMinutelyStats).toHaveBeenCalledWith(
        'tenant-a',
        60,
      );
    });

    it('clamps an unbounded window to 24h', async () => {
      analyticsService.getMinutelyStats.mockResolvedValue([]);

      await controller.getMinutelyStats(minutely(100_000), ctx());

      expect(analyticsService.getMinutelyStats).toHaveBeenCalledWith(
        'tenant-a',
        24 * 60,
      );
    });
  });
});
