import { register } from 'prom-client';
import { OpsServer } from '../ops-server';
import { READINESS_PROBES } from '../health.probes';
import type { HealthProbesService } from '../services/health-probes.service';

describe('OpsServer', () => {
  let server: OpsServer;
  let base: string;
  const report = jest.fn();
  const role = process.env.SERVICE_ROLE;

  beforeEach(async () => {
    process.env.SERVICE_ROLE = 'scheduler';
    report.mockReset();
    server = new OpsServer({ report } as unknown as HealthProbesService);
    const port = await server.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.onApplicationShutdown();
    process.env.SERVICE_ROLE = role;
  });

  it('answers /livez without checking dependencies', async () => {
    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(200);
    expect(report).not.toHaveBeenCalled();
  });

  it("requires only the role's probes on /readyz", async () => {
    report.mockResolvedValue({ status: 'ok', degraded: [] });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(report).toHaveBeenCalledWith(
      READINESS_PROBES.scheduler,
      'readiness',
    );
  });

  it('stays ready with degraded optional dependencies and lists them', async () => {
    report.mockResolvedValue({
      status: 'ok',
      error: { clickhouse: { status: 'down' } },
      degraded: ['clickhouse'],
    });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ degraded: ['clickhouse'] });
  });

  it('reports 503 with the failing probe when a required dependency is down', async () => {
    report.mockResolvedValue({
      status: 'error',
      info: {},
      details: {},
      error: { redis: { status: 'down', message: 'connect 10.0.0.7:6379' } },
      degraded: [],
    });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({
      error: { redis: { status: 'down' } },
    });
    expect(body).not.toContain('10.0.0.7');
  });

  it('reports starting until the probes are attached at the end of boot', async () => {
    const early = new OpsServer();
    const port = await early.listen(0, '127.0.0.1');
    try {
      const url = `http://127.0.0.1:${port}`;
      expect((await fetch(`${url}/livez`)).status).toBe(200);
      const res = await fetch(`${url}/readyz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'starting' });

      report.mockResolvedValue({ status: 'ok', degraded: [] });
      early.attach({ report } as unknown as HealthProbesService);
      expect((await fetch(`${url}/readyz`)).status).toBe(200);
    } finally {
      await early.onApplicationShutdown();
    }
  });

  it('answers 500 when the metrics registry fails', async () => {
    const spy = jest
      .spyOn(register, 'metrics')
      .mockRejectedValueOnce(new Error('collector threw'));
    try {
      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports not ready once shutdown begins', async () => {
    report.mockResolvedValue({ status: 'ok' });
    server.drain();
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(report).not.toHaveBeenCalled();
  });

  it('serves Prometheus metrics on /metrics', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('answers 404 elsewhere', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(404);
  });
});
