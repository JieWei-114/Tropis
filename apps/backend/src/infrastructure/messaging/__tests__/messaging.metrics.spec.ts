import { register } from 'prom-client';
import { consumeEnveloped, encodeOutgoing } from '../messaging.envelope';
import {
  MESSAGING_FAILED_METRIC,
  MESSAGING_PROCESSED_METRIC,
} from '../messaging.metrics';

async function value(name: string, subscription: string): Promise<number> {
  const data = await register.getSingleMetric(name)?.get();
  return (
    data?.values.find((v) => v.labels.subscription === subscription)?.value ?? 0
  );
}

describe('consumer metrics', () => {
  it('counts processed and failed messages per subscription', async () => {
    const out = encodeOutgoing('t', { n: 1 }, { event: { tenantId: 'acme' } });
    await consumeEnveloped(
      'memory',
      't',
      'metrics-sub',
      out.data,
      out.properties,
      () => undefined,
    );
    await expect(
      consumeEnveloped(
        'memory',
        't',
        'metrics-sub',
        out.data,
        out.properties,
        () => {
          throw new Error('sink down');
        },
      ),
    ).rejects.toThrow('sink down');
    expect(await value(MESSAGING_PROCESSED_METRIC, 'metrics-sub')).toBe(1);
    expect(await value(MESSAGING_FAILED_METRIC, 'metrics-sub')).toBe(1);
  });
});
