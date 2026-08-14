import { Test } from '@nestjs/testing';
import { TrackingService } from '../services/tracking.service';
import { TrackingRepository } from '../repositories/tracking.repository';
import { MESSAGE_BROKER } from '../../../infrastructure/messaging/message-broker.port';
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
  let repo: {
    getTopPages: jest.Mock;
    getEventsByName: jest.Mock;
    getDailyUniques: jest.Mock;
    getRecent: jest.Mock;
  };

  beforeEach(async () => {
    broker = { publish: jest.fn().mockResolvedValue(undefined) };
    repo = {
      getTopPages: jest.fn().mockResolvedValue([{ page: '/a', count: 3 }]),
      getEventsByName: jest
        .fn()
        .mockResolvedValue([{ eventName: 'page_view', count: 3 }]),
      getDailyUniques: jest
        .fn()
        .mockResolvedValue([{ day: '2026-08-11', uniques: 2 }]),
      getRecent: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TrackingService,
        { provide: TrackingRepository, useValue: repo },
        { provide: MESSAGE_BROKER, useValue: broker },
      ],
    }).compile();

    service = moduleRef.get(TrackingService);
  });

  describe('ingest', () => {
    it('publishes the enriched batch directly to the broker (no outbox)', async () => {
      await service.ingest(batch(), 'tenant-a');

      expect(broker.publish).toHaveBeenCalledTimes(1);
      const [topic, payload] = broker.publish.mock.calls[0] as [
        string,
        { events: Record<string, unknown>[] },
      ];
      expect(topic).toBe('persistent://public/default/tracking-events');
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
      await service.ingest(batch());
      await service.ingest(batch());
      expect(broker.publish).toHaveBeenCalledTimes(2);
    });

    it('never throws when the broker is down (lossy-tolerant)', async () => {
      broker.publish.mockRejectedValue(new Error('broker down'));
      await expect(service.ingest(batch())).resolves.toBeUndefined();
    });
  });

  describe('getInsights', () => {
    it('aggregates the four ClickHouse queries', async () => {
      const insights = await service.getInsights(7);

      expect(repo.getTopPages).toHaveBeenCalledWith(7);
      expect(repo.getEventsByName).toHaveBeenCalledWith(7);
      expect(repo.getDailyUniques).toHaveBeenCalledWith(7);
      expect(repo.getRecent).toHaveBeenCalled();
      expect(insights).toEqual({
        topPages: [{ page: '/a', count: 3 }],
        eventsByName: [{ eventName: 'page_view', count: 3 }],
        dailyUniques: [{ day: '2026-08-11', uniques: 2 }],
        recent: [],
      });
    });

    it('falls back to the default window for non-positive days', async () => {
      await service.getInsights(0);
      expect(repo.getTopPages).toHaveBeenCalledWith(7);
    });
  });
});
