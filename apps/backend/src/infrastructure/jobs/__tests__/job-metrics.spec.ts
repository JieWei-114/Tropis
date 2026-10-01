import { register } from 'prom-client';
import { JOBS_COMPLETED_METRIC, JOBS_FAILED_METRIC } from '../job-metrics';
import { JOB_TENANT_FIELD } from '../job-tenant';
import { processWithTrace } from '../job-trace';

async function value(name: string, queue: string): Promise<number> {
  const metric = register.getSingleMetric(name);
  const data = await metric?.get();
  return data?.values.find((v) => v.labels.queue === queue)?.value ?? 0;
}

describe('job metrics', () => {
  it('counts completed and failed attempts per queue', async () => {
    const job = {
      id: '1',
      name: 'n',
      data: { [JOB_TENANT_FIELD]: { scope: 'global' } },
      attemptsMade: 0,
    };
    await processWithTrace('test', 'metrics-q', job, () => Promise.resolve());
    await expect(
      processWithTrace('test', 'metrics-q', job, () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');
    expect(await value(JOBS_COMPLETED_METRIC, 'metrics-q')).toBe(1);
    expect(await value(JOBS_FAILED_METRIC, 'metrics-q')).toBe(1);
  });
});
