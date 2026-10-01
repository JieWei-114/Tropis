import { Test } from '@nestjs/testing';
import { getToken } from '@willsoto/nestjs-prometheus';
import { TrackingService } from '../services/tracking.service';
import { TrackingRepository } from '../repositories/tracking.repository';
import { MESSAGING } from '../../../infrastructure/messaging/messaging.port';
import { toTenantId } from '../../../common/keyspace';
import { DEDUP } from '../../../infrastructure/dedup/dedup.port';
import { InMemoryDedupAdapter } from '../../../infrastructure/dedup/__tests__/in-memory-dedup.adapter';
import {
  TRACKING_CLAIM_TTL_SECONDS,
  TRACKING_DUPLICATES_METRIC,
  TRACKING_EVENT_SEEN,
  TRACKING_SEEN_TTL_SECONDS,
} from '../constants/tracking.constants';
import { TENANT_DIRECTORY } from '../../../common/tenant/tenant-directory.port';
import { TrackBatchDto } from '../dto/track-event.dto';

const batch = (): TrackBatchDto => ({
  events: [
    {
      eventId: 'evt-1',
      eventName: 'page_view',
      anonymousId: 'anon-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      page: '/behavior',
      referrer: '',
      userAgent: 'jest',
      screen: '100x100',
      props: { path: '/behavior' },
      timestamp: 1735689600000,
    },
  ],
});

describe('TrackingService', () => {
  let service: TrackingService;
  let broker: { publish: jest.Mock };
  let dedup: InMemoryDedupAdapter;
  let repo: {
    getTopPages: jest.Mock;
    getEventsByName: jest.Mock;
    getDailyUniques: jest.Mock;
    getRecent: jest.Mock;
    getFunnel: jest.Mock;
  };

  let tenants: { find: jest.Mock };

  beforeEach(async () => {
    tenants = {
      find: jest.fn().mockResolvedValue({
        id: 'tenant-a',
        name: 'A',
        status: 'active',
        selfSignup: false,
      }),
    };
    broker = { publish: jest.fn().mockResolvedValue(undefined) };
    // Default: nothing seen before, so every claim succeeds.
    dedup = new InMemoryDedupAdapter();
    repo = {
      getTopPages: jest.fn().mockResolvedValue([{ page: '/a', count: 3 }]),
      getEventsByName: jest
        .fn()
        .mockResolvedValue([{ eventName: 'page_view', count: 3 }]),
      getDailyUniques: jest
        .fn()
        .mockResolvedValue([{ day: '2026-08-11', uniques: 2 }]),
      getRecent: jest.fn().mockResolvedValue([]),
      getFunnel: jest.fn().mockResolvedValue([{ step: 'page_view', users: 3 }]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TrackingService,
        { provide: TrackingRepository, useValue: repo },
        { provide: MESSAGING, useValue: broker },
        { provide: DEDUP, useValue: dedup },
        { provide: TENANT_DIRECTORY, useValue: tenants },
        {
          provide: getToken(TRACKING_DUPLICATES_METRIC),
          useValue: { inc: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(TrackingService);
  });

  describe('ingest', () => {
    it('drops an event whose eventId was already ingested', async () => {
      // Every event carries a client-generated eventId, and beacons retry, so
      // a replayed batch must not be published (and counted) twice.
      await service.ingest(toTenantId('tenant-a'), batch());
      broker.publish.mockClear();

      await service.ingest(toTenantId('tenant-a'), batch());

      expect(broker.publish).not.toHaveBeenCalled();
    });

    it('claims per tenant, so the same eventId from another tenant is not a duplicate', async () => {
      const claim = jest.spyOn(dedup, 'claimMany');
      await service.ingest(toTenantId('tenant-a'), batch());
      await service.ingest(toTenantId('tenant-b'), batch());

      expect(broker.publish).toHaveBeenCalledTimes(2);
      expect(claim).toHaveBeenCalledWith(
        [TRACKING_EVENT_SEEN.forTenant(toTenantId('tenant-a'), 'evt-1')],
        TRACKING_CLAIM_TTL_SECONDS,
        expect.any(String),
      );
    });

    // Reproduces the gap: the eventId was claimed for 24 h before the
    // publish, so a batch whose publish failed was dropped as a duplicate on
    // every retry for a day.
    it('releases the claims when the publish fails, so a retry is accepted', async () => {
      broker.publish.mockRejectedValueOnce(new Error('broker down'));
      await service.ingest(toTenantId('tenant-a'), batch());

      await service.ingest(toTenantId('tenant-a'), batch());

      expect(broker.publish).toHaveBeenCalledTimes(2);
    });

    it('claims briefly before the publish and extends the claim after it', async () => {
      const extend = jest.spyOn(dedup, 'extendMany');
      await service.ingest(toTenantId('tenant-a'), batch());

      expect(TRACKING_CLAIM_TTL_SECONDS).toBeLessThan(
        TRACKING_SEEN_TTL_SECONDS,
      );
      expect(extend).toHaveBeenCalledWith(
        [TRACKING_EVENT_SEEN.forTenant(toTenantId('tenant-a'), 'evt-1')],
        TRACKING_SEEN_TTL_SECONDS,
        expect.any(String),
      );
    });

    it('still publishes when the dedup store is unavailable (availability over exactness)', async () => {
      jest.spyOn(dedup, 'claimMany').mockRejectedValue(new Error('down'));

      await service.ingest(toTenantId('tenant-a'), batch());

      expect(broker.publish).toHaveBeenCalledTimes(1);
    });

    it('publishes the enriched batch directly to the broker (no outbox)', async () => {
      await service.ingest(toTenantId('tenant-a'), batch());

      expect(broker.publish).toHaveBeenCalledTimes(1);
      const [topic, payload] = broker.publish.mock.calls[0] as [
        string,
        { events: Record<string, unknown>[] },
      ];
      expect(topic).toBe('tracking-events');
      expect(broker.publish.mock.calls[0][2]).toMatchObject({
        event: { tenantId: 'tenant-a' },
      });
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]).toMatchObject({
        eventId: 'evt-1',
        eventName: 'page_view',
        anonymousId: 'anon-1',
        tenantId: 'tenant-a',
      });
      expect(typeof payload.events[0].receivedAt).toBe('number'); // server enrichment
    });

    it('publishes each batch through the broker port', async () => {
      jest.spyOn(dedup, 'claimMany').mockResolvedValue([true]);
      await service.ingest(toTenantId('tenant-a'), batch());
      await service.ingest(toTenantId('tenant-a'), batch());
      expect(broker.publish).toHaveBeenCalledTimes(2);
    });

    it('never throws when the broker is down (lossy-tolerant)', async () => {
      broker.publish.mockRejectedValue(new Error('broker down'));
      await expect(
        service.ingest(toTenantId('tenant-a'), batch()),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertAccepting', () => {
    // Reproduces the gap: anonymous ingest wrote into any tenant id the
    // caller named, registered or not, suspended or not.
    it('rejects an unregistered tenant', async () => {
      tenants.find.mockResolvedValue(null);
      await expect(
        service.assertAccepting(toTenantId('ghost')),
      ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
    });

    it('rejects a suspended tenant', async () => {
      tenants.find.mockResolvedValue({
        id: 'tenant-a',
        name: 'A',
        status: 'suspended',
        selfSignup: false,
      });
      await expect(
        service.assertAccepting(toTenantId('tenant-a')),
      ).rejects.toMatchObject({ code: 'TENANT_INACTIVE' });
    });

    it('accepts an active tenant', async () => {
      await expect(
        service.assertAccepting(toTenantId('tenant-a')),
      ).resolves.toBeUndefined();
    });

    it('answers SERVICE_UNAVAILABLE when the directory cannot be read', async () => {
      tenants.find.mockRejectedValue(new Error('mongo down'));
      await expect(
        service.assertAccepting(toTenantId('tenant-a')),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    });
  });

  describe('getInsights', () => {
    it('scopes every query to the given tenant', async () => {
      // logs.user_behavior carries tenant_id; a query that does not filter on
      // it shows every tenant's traffic on the behaviour dashboard.
      await service.getInsights(toTenantId('tenant-b'), 7);

      for (const fn of [
        repo.getTopPages,
        repo.getEventsByName,
        repo.getDailyUniques,
        repo.getFunnel,
      ]) {
        expect(fn).toHaveBeenCalledWith(7, 'tenant-b');
      }
      expect(repo.getRecent).toHaveBeenCalledWith('tenant-b');
    });

    it('aggregates the four OLAP queries', async () => {
      const insights = await service.getInsights(toTenantId('tenant-a'), 7);

      expect(repo.getTopPages).toHaveBeenCalledWith(7, 'tenant-a');
      expect(repo.getEventsByName).toHaveBeenCalledWith(7, 'tenant-a');
      expect(repo.getDailyUniques).toHaveBeenCalledWith(7, 'tenant-a');
      expect(repo.getRecent).toHaveBeenCalled();
      expect(repo.getFunnel).toHaveBeenCalledWith(7, 'tenant-a');
      expect(insights).toEqual({
        topPages: [{ page: '/a', count: 3 }],
        eventsByName: [{ eventName: 'page_view', count: 3 }],
        dailyUniques: [{ day: '2026-08-11', uniques: 2 }],
        funnel: [{ step: 'page_view', users: 3 }],
        recent: [],
      });
    });

    it('falls back to the default window for non-positive days', async () => {
      await service.getInsights(toTenantId('tenant-a'), 0);
      expect(repo.getTopPages).toHaveBeenCalledWith(7, 'tenant-a');
    });
  });
});
