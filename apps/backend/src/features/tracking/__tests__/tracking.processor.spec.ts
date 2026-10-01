import { toTenantId } from '../../../common/keyspace';
import { consumerHarness } from '../../../infrastructure/messaging/__tests__/consumer-harness';
import type { RealtimePort } from '../../../infrastructure/realtime/realtime.port';
import {
  TRACKING_EVENT_WRITTEN,
  TRACKING_SEEN_TTL_SECONDS,
} from '../constants/tracking.constants';
import { TrackingProcessor } from '../processors/tracking.processor';
import type { TrackingRepository } from '../repositories/tracking.repository';
import { TrackingSinkService } from '../services/tracking-sink.service';

const TENANT = toTenantId('acme');

const event = (eventId: string) => ({
  eventId,
  eventName: 'page.view',
  anonymousId: 'anon',
  sessionId: 's1',
  page: '/',
  referrer: '',
  userAgent: 'ua',
  screen: '1x1',
  timestamp: 1,
});
const batch = (...ids: string[]) => ({ events: ids.map(event) });

async function start() {
  const h = consumerHarness();
  const insertEvents = jest.fn().mockResolvedValue(undefined);
  const realtime = {
    publishToTenant: jest.fn().mockResolvedValue(undefined),
  };
  const processor = new TrackingProcessor(
    h.consumer,
    new TrackingSinkService(
      { insertEvents } as unknown as TrackingRepository,
      realtime as unknown as RealtimePort,
    ),
  );
  processor.onModuleInit();
  const deliver = (data: unknown) => h.deliver(data);
  const written = () =>
    insertEvents.mock.calls.flatMap(
      ([, rows]: [unknown, { event_id: string }[]]) =>
        rows.map((r) => r.event_id),
    );
  return { deliver, insertEvents, realtime, dedup: h.dedup, written };
}

describe('TrackingProcessor', () => {
  it('writes a redelivered batch once, deduplicated on event id', async () => {
    const { deliver, insertEvents, written } = await start();

    await deliver(batch('e1', 'e2'));
    await deliver(batch('e1', 'e2'));

    expect(insertEvents).toHaveBeenCalledTimes(1);
    expect(written()).toEqual(['e1', 'e2']);
  });

  it('writes only the events of a batch not written before', async () => {
    const { deliver, written, dedup } = await start();

    await deliver(batch('e1'));
    await deliver(batch('e1', 'e2'));

    expect(written()).toEqual(['e1', 'e2']);
    expect(dedup.extendMany).toHaveBeenCalledWith(
      [TRACKING_EVENT_WRITTEN.forTenant(TENANT, 'e2')],
      TRACKING_SEEN_TTL_SECONDS,
      expect.any(String),
    );
  });

  it('releases its claims and rethrows when the insert fails, so a redelivery is written', async () => {
    const { deliver, insertEvents, dedup, written } = await start();
    insertEvents.mockRejectedValueOnce(new Error('olap down'));

    await expect(deliver(batch('e1', 'e2'))).rejects.toThrow('olap down');
    expect(dedup.keys.size).toBe(0);

    await deliver(batch('e1', 'e2'));
    expect(written()).toEqual(['e1', 'e2', 'e1', 'e2']);
    expect(insertEvents).toHaveBeenCalledTimes(2);
  });

  it('pushes the live nudge after a write and not for a fully duplicate batch', async () => {
    const { deliver, realtime } = await start();

    await deliver(batch('e1'));
    await deliver(batch('e1'));

    expect(realtime.publishToTenant).toHaveBeenCalledTimes(1);
    expect(realtime.publishToTenant).toHaveBeenCalledWith(
      TENANT,
      'tracking.event',
      expect.objectContaining({ count: 1 }),
    );
  });
});
