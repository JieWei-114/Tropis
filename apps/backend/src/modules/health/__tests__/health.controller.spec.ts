import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../controllers/health.controller';
import type {
  HealthProbesService,
  HealthReport,
} from '../services/health-probes.service';

const report = (status: HealthReport['status']): HealthReport => ({
  status,
  info: { mongo: { status: 'up' } },
  error: { clickhouse: { status: 'down', message: 'connect 10.0.0.5:8123' } },
  details: {
    mongo: { status: 'up' },
    clickhouse: { status: 'down', message: 'connect 10.0.0.5:8123' },
  },
  degraded: status === 'ok' ? ['clickhouse'] : [],
});

describe('HealthController', () => {
  const controller = (r: HealthReport) =>
    new HealthController({
      report: () => Promise.resolve(r),
    } as unknown as HealthProbesService);

  it('answers 200 with degraded optional probes and no probe messages', async () => {
    const body = await controller(report('ok')).check();
    expect(body.degraded).toEqual(['clickhouse']);
    expect(body.error.clickhouse).toEqual({ status: 'down' });
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('answers 503 through the error filter when a required probe is down', async () => {
    await expect(controller(report('error')).check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
