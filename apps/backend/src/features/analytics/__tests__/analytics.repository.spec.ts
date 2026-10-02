import { AppError } from '../../../common/errors/app-error';
import { toTenantId } from '../../../common/keyspace';
import type { OlapPort } from '../../../infrastructure/olap/olap.port';
import { AnalyticsRepository } from '../repositories/analytics.repository';

const TENANT = toTenantId('acme');
const EVENT = {
  event_id: 'e1',
  event_type: 'page_view',
  user_id: 'u1',
  payload: '{}',
  ts: 1,
};

describe('AnalyticsRepository.insertEvent', () => {
  it('rejects with a retryable SERVICE_UNAVAILABLE when the OLAP insert fails', async () => {
    const cause = new Error('connection refused');
    const olap = {
      insert: jest.fn().mockRejectedValue(cause),
    } as unknown as OlapPort;
    const repo = new AnalyticsRepository(olap);

    const err = await repo.insertEvent(TENANT, EVENT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as AppError).retryable).toBe(true);
    expect((err as Error).cause).toBe(cause);
  });

  it('inserts the event for the tenant', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const olap = { insert } as unknown as OlapPort;
    await new AnalyticsRepository(olap).insertEvent(TENANT, EVENT);
    expect(insert).toHaveBeenCalledWith(TENANT, 'logs.analytics_events', [
      EVENT,
    ]);
  });
});
