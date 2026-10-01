import type { ConfigService } from '@nestjs/config';
import { AppError } from '../../../common/errors/app-error';
import { toTenantId } from '../../../common/keyspace';
import { consumerHarness } from '../../../infrastructure/messaging/__tests__/consumer-harness';
import type { OlapPort } from '../../../infrastructure/olap/olap.port';
import type { RealtimePort } from '../../../infrastructure/realtime/realtime.port';
import { ANALYTICS_EVENT_SEEN } from '../constants/analytics.constants';
import { AnalyticsProcessor } from '../processors/analytics.processor';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import { AnalyticsSinkService } from '../services/analytics-sink.service';

const TENANT = toTenantId('acme');
const body = (eventId = 'e1') => ({
  eventId,
  eventType: 'page_view',
  userId: 'u1',
  timestamp: 1,
});

async function start(olapInsert: jest.Mock) {
  const h = consumerHarness();
  const realtime = {
    publishToRoles: jest.fn().mockResolvedValue(undefined),
  } as unknown as RealtimePort;
  const repo = new AnalyticsRepository({
    insert: olapInsert,
  } as unknown as OlapPort);
  const processor = new AnalyticsProcessor(
    h.consumer,
    new AnalyticsSinkService(repo, realtime),
    { get: () => 'node' } as unknown as ConfigService,
  );
  processor.onModuleInit();
  const deliver = (data: unknown) => h.deliver(data, { id: 'env-1' });
  return { deliver, dedup: h.dedup, realtime };
}

describe('AnalyticsProcessor', () => {
  it('nacks (rejects) when OLAP is down and releases the claim so a redelivery is written', async () => {
    const insert = jest
      .fn()
      .mockRejectedValueOnce(new Error('olap down'))
      .mockResolvedValueOnce(undefined);
    const { deliver, dedup } = await start(insert);

    const err = await deliver(body()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SERVICE_UNAVAILABLE');
    expect(dedup.keys.size).toBe(0);

    await expect(deliver(body())).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledTimes(2);
    expect(dedup.extendMany).toHaveBeenCalledWith(
      [ANALYTICS_EVENT_SEEN.global('e1')],
      24 * 60 * 60,
      expect.any(String),
    );
  });

  it('writes a redelivered event once, deduplicated on its event id', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const { deliver } = await start(insert);

    await deliver(body('e1'));
    await deliver(body('e1'));
    await deliver(body('e2'));

    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('keeps the event stored when the live push fails', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const { deliver, realtime } = await start(insert);
    (realtime.publishToRoles as jest.Mock).mockRejectedValue(new Error('x'));

    await expect(deliver(body())).resolves.toBeUndefined();
  });

  it('pushes the live feed only to roles that may read analytics', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const { deliver, realtime } = await start(insert);

    await deliver(body());

    expect(realtime.publishToRoles).toHaveBeenCalledWith(
      TENANT,
      ['admin', 'editor', 'viewer'],
      'analytics.event',
      expect.anything(),
    );
  });
});
