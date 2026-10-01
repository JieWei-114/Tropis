import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SpanKind } from '@opentelemetry/api';
import {
  Code,
  ConnectError,
  createClient,
  type ConnectRouter,
  type HandlerContext,
  type Transport,
} from '@connectrpc/connect';
import {
  connectNodeAdapter,
  createConnectTransport,
  createGrpcTransport,
} from '@connectrpc/connect-node';
import { register } from 'prom-client';
import {
  captureLogs,
  installTracing,
  TRACE_ID,
  TRACEPARENT,
} from '../../../common/observability/__tests__/harness';
import { createLogger } from '../../../common/observability/logger';
import { RPC_REQUESTS_METRIC } from '../../../common/observability/metrics';
import { HealthService } from '../../../gen/health/v1/health_pb';
import {
  BadRequestSchema,
  ErrorInfoSchema,
} from '../../../gen/google/rpc/error_details_pb';
import { correlationInterceptor } from '../interceptors/correlation.interceptor';
import { errorsInterceptor } from '../interceptors/errors.interceptor';
import { metricsInterceptor } from '../interceptors/metrics.interceptor';
import { RpcListener } from '../rpc-listener';
import type { RpcRequestHandler } from '../rpc-cors';

const PARENT_SPAN_ID = TRACEPARENT.split('-')[2];

/** HealthService whose behaviour the caller picks with an `x-case` header. */
const impl = {
  check(_req: unknown, ctx: HandlerContext) {
    createLogger('health').info('check-served', 'check served');
    switch (ctx.requestHeader.get('x-case')) {
      case 'domain':
        throw new NotFoundException('USER_NOT_FOUND');
      case 'validation':
        throw new BadRequestException({ message: ['email must be an email'] });
      case 'boom':
        throw new Error('mongo down at 10.0.0.5');
      case 'connect':
        throw new ConnectError('Invalid credentials', Code.Unauthenticated);
      default:
        return { status: 'ok', timestamp: '2026-09-30T00:00:00.000Z' };
    }
  },
};

describe('RPC errors, trace propagation and RED metrics', () => {
  const otel = installTracing();
  const logs = captureLogs();
  let listener: RpcListener;
  let port: number;

  beforeAll(async () => {
    const handler = connectNodeAdapter({
      routes: (router: ConnectRouter) => router.service(HealthService, impl),
      interceptors: [
        metricsInterceptor(),
        correlationInterceptor,
        errorsInterceptor,
      ],
    }) as RpcRequestHandler;
    listener = new RpcListener(handler);
    port = await listener.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await listener.close();
    await otel.shutdown();
  });

  beforeEach(() => {
    otel.reset();
    logs.records.length = 0;
  });

  const url = () => `http://127.0.0.1:${port}`;
  const transports: Array<[string, () => Transport]> = [
    ['gRPC over h2c', () => createGrpcTransport({ baseUrl: url() })],
    [
      'Connect over HTTP/1.1',
      () => createConnectTransport({ baseUrl: url(), httpVersion: '1.1' }),
    ],
  ];

  const call = async (
    transport: Transport,
    headers: Record<string, string>,
  ) => {
    let responseHeaders: Headers | undefined;
    try {
      await createClient(HealthService, transport).check(
        {},
        { headers, onHeader: (h) => (responseHeaders = h) },
      );
      return { headers: responseHeaders, error: undefined };
    } catch (e) {
      return { headers: responseHeaders, error: ConnectError.from(e) };
    }
  };

  describe.each(transports)('%s', (_name, transport) => {
    it('continues the caller trace and echoes its id', async () => {
      const res = await call(transport(), {
        traceparent: TRACEPARENT,
        'x-request-id': 'client-chosen',
      });
      expect(res.error).toBeUndefined();
      expect(res.headers?.get('trace-id')).toBe(TRACE_ID);
      expect(res.headers?.get('x-request-id')).toBe(TRACE_ID);

      const span = otel
        .spans()
        .find((s) => s.name === 'tropis.health.v1.HealthService/Check');
      expect(span?.kind).toBe(SpanKind.SERVER);
      expect(span?.spanContext().traceId).toBe(TRACE_ID);
      expect(span?.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
      expect(span?.attributes).toMatchObject({
        'rpc.system': 'connect_rpc',
        'rpc.service': 'tropis.health.v1.HealthService',
        'rpc.method': 'Check',
        'http.request.header.x-request-id': ['client-chosen'],
      });
      expect(
        logs.records.find((r) => r.event === 'health.check-served'),
      ).toMatchObject({
        trace_id: TRACE_ID,
        span_id: span?.spanContext().spanId,
      });
    });

    it('sends a catalog code as ErrorInfo with the trace id in metadata', async () => {
      const { error } = await call(transport(), {
        traceparent: TRACEPARENT,
        'x-case': 'domain',
      });
      expect(error?.code).toBe(Code.NotFound);
      expect(error?.rawMessage).toBe('The user was not found.');
      expect(error?.metadata.get('trace-id')).toBe(TRACE_ID);
      expect(error?.findDetails(ErrorInfoSchema)[0]).toMatchObject({
        reason: 'USER_NOT_FOUND',
        domain: 'tropis',
        metadata: { retryable: 'false' },
      });
    });

    it('sends validation failures as google.rpc.BadRequest', async () => {
      const { error } = await call(transport(), { 'x-case': 'validation' });
      expect(error?.code).toBe(Code.InvalidArgument);
      expect(error?.findDetails(BadRequestSchema)[0]?.fieldViolations).toEqual([
        expect.objectContaining({
          field: 'email',
          description: 'email must be an email',
        }),
      ]);
    });

    it('hides an unexpected error and logs it under the same trace id', async () => {
      const { error } = await call(transport(), {
        traceparent: TRACEPARENT,
        'x-case': 'boom',
      });
      expect(error?.code).toBe(Code.Internal);
      expect(error?.rawMessage).toBe('An internal error occurred.');
      expect(error?.metadata.get('trace-id')).toBe(TRACE_ID);
      expect(
        logs.records.find((r) => r.event === 'rpc.unhandled-error'),
      ).toMatchObject({
        level: 'error',
        trace_id: TRACE_ID,
        'error.message': 'mongo down at 10.0.0.5',
        'rpc.method': 'Check',
      });
      const span = otel.spans().find((s) => s.kind === SpanKind.SERVER);
      expect(span?.status.code).toBe(2);
      expect(span?.attributes['rpc.connect_rpc.error_code']).toBe('internal');
    });

    it('keeps a handler ConnectError and adds the generic ErrorInfo', async () => {
      const { error } = await call(transport(), { 'x-case': 'connect' });
      expect(error?.code).toBe(Code.Unauthenticated);
      expect(error?.rawMessage).toBe('Invalid credentials');
      expect(error?.findDetails(ErrorInfoSchema)[0]?.reason).toBe(
        'UNAUTHORIZED',
      );
      expect(error?.metadata.get('trace-id')).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  it('counts calls by service, method and Connect code', async () => {
    await call(transports[0][1](), {});
    await call(transports[0][1](), { 'x-case': 'domain' });
    const metric = await register.getSingleMetric(RPC_REQUESTS_METRIC)!.get();
    const labels = metric.values.map((v) => v.labels);
    expect(labels).toEqual(
      expect.arrayContaining([
        {
          service: 'tropis.health.v1.HealthService',
          method: 'Check',
          code: 'ok',
        },
        {
          service: 'tropis.health.v1.HealthService',
          method: 'Check',
          code: 'not_found',
        },
        {
          service: 'tropis.health.v1.HealthService',
          method: 'Check',
          code: 'internal',
        },
      ]),
    );
  });
});
