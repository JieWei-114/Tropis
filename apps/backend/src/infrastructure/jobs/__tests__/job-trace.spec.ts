import { SpanKind, trace } from '@opentelemetry/api';
import type { ConfigService } from '@nestjs/config';
import type { DiscoveryService, Reflector } from '@nestjs/core';
import {
  installTracing,
  TRACE_ID,
  TRACEPARENT,
} from '../../../common/observability/__tests__/harness';
import { runInExtractedSpan } from '../../../common/observability/propagation';
import { currentRequestContext } from '../../../common/observability/request-context';
import { toTenantId } from '../../../common/keyspace';
import { AppError } from '../../../common/errors/app-error';
import {
  currentTenant,
  runInTenant,
} from '../../../common/tenant/tenant.context';
import { BullmqJobsAdapter } from '../adapters/bullmq/bullmq-jobs.adapter';
import type { BullmqQueues } from '../adapters/bullmq/bullmq-queues';
import { BullmqWorkersService } from '../adapters/bullmq/bullmq-workers.service';
import {
  attachTraceContext,
  detachTraceContext,
  JOB_TRACE_FIELD,
  processWithTrace,
} from '../job-trace';
import { JOB_TENANT_FIELD } from '../job-tenant';
import type { JobContext } from '../jobs.port';
import { JobQueueRegistry } from '../jobs.registry';
import {
  NOTIFICATION_QUEUE,
  QUEUE_NOTIFICATION,
} from '../../../modules/notification/constants/notification.constants';

function registry(): JobQueueRegistry {
  const r = new JobQueueRegistry();
  r.register(NOTIFICATION_QUEUE);
  return r;
}

type Processor = (job: unknown) => Promise<unknown>;
const processors: Processor[] = [];
jest.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {
    name = 'UnrecoverableError';
  },
  Queue: jest.fn().mockImplementation(() => ({ close: jest.fn() })),
  Worker: jest.fn().mockImplementation((_q: string, fn: Processor) => {
    processors.push(fn);
    return { on: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };
  }),
}));

const otel = installTracing();
afterAll(() => otel.shutdown());
beforeEach(() => {
  otel.reset();
  processors.length = 0;
});

const inRequest = <T>(fn: () => Promise<T>) =>
  runInExtractedSpan(
    { traceparent: TRACEPARENT },
    'POST /api/users',
    { kind: SpanKind.SERVER },
    () => runInTenant(toTenantId('acme'), fn),
  );

describe('job trace context', () => {
  it('attaches the carrier to object data only', () => {
    const carrier = { traceparent: TRACEPARENT };
    expect(attachTraceContext({ a: 1 }, carrier)).toEqual({
      a: 1,
      [JOB_TRACE_FIELD]: carrier,
    });
    expect(attachTraceContext('text', carrier)).toBe('text');
    expect(attachTraceContext([1], carrier)).toEqual([1]);
    expect(attachTraceContext({ a: 1 }, {})).toEqual({ a: 1 });
  });

  it('detaches the carrier and hands back the original data', () => {
    expect(
      detachTraceContext({ a: 1, [JOB_TRACE_FIELD]: { traceparent: 'x' } }),
    ).toEqual({ data: { a: 1 }, carrier: { traceparent: 'x' } });
    expect(detachTraceContext({ a: 1 })).toEqual({
      data: { a: 1 },
      carrier: {},
    });
  });

  it('enqueues inside a PRODUCER span whose context the job data carries', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'job-1' });
    const adapter = new BullmqJobsAdapter(registry(), {
      get: () => ({ add }),
      close: jest.fn(),
    } as unknown as BullmqQueues);

    await inRequest(() =>
      adapter.enqueue(QUEUE_NOTIFICATION, 'send-notification', { a: 1 }),
    );

    const data = add.mock.calls[0][1] as Record<string, unknown>;
    const carrier = data[JOB_TRACE_FIELD] as { traceparent: string };
    expect(data.a).toBe(1);
    const producer = otel
      .spans()
      .find((s) => s.name === `publish ${QUEUE_NOTIFICATION}`)!;
    expect(producer.kind).toBe(SpanKind.PRODUCER);
    expect(producer.spanContext().traceId).toBe(TRACE_ID);
    expect(producer.attributes['messaging.message.id']).toBe('job-1');
    expect(carrier.traceparent).toContain(producer.spanContext().spanId);
  });

  it('runs a @JobHandler attempt in a CONSUMER span continuing the trace, without the trace field', async () => {
    const seen: Array<{
      job: JobContext;
      traceId?: string;
      tenant?: string;
      scoped?: string;
    }> = [];
    class Handler {
      process(job: JobContext) {
        seen.push({
          job,
          traceId: trace.getActiveSpan()?.spanContext().traceId,
          tenant: currentRequestContext()?.tenantId,
          scoped: currentTenant(),
        });
        return Promise.resolve();
      }
    }
    const service = new BullmqWorkersService(
      {
        getProviders: () => [{ instance: new Handler(), metatype: Handler }],
      } as unknown as DiscoveryService,
      { get: () => QUEUE_NOTIFICATION } as unknown as Reflector,
      {
        get: () => undefined,
        getOrThrow: () => 'localhost',
      } as unknown as ConfigService,
      registry(),
    );
    service.onApplicationBootstrap();

    await processors[0]({
      id: 'j1',
      name: 'send-notification',
      attemptsMade: 0,
      data: {
        userId: 'u1',
        tenantId: 'acme',
        [JOB_TRACE_FIELD]: { traceparent: TRACEPARENT },
        [JOB_TENANT_FIELD]: { scope: 'tenant', tenantId: 'acme' },
      },
    });

    expect(seen[0].job.data).toEqual({ userId: 'u1', tenantId: 'acme' });
    expect(seen[0].traceId).toBe(TRACE_ID);
    expect(seen[0].tenant).toBe('acme');
    expect(seen[0].scoped).toBe('acme');
    const consumer = otel
      .spans()
      .find((s) => s.name === `process ${QUEUE_NOTIFICATION}`)!;
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(consumer.attributes['messaging.message.id']).toBe('j1');
  });

  it('records a failed attempt on the span and rethrows', async () => {
    await expect(
      processWithTrace(
        'bullmq',
        QUEUE_NOTIFICATION,
        {
          id: 'j2',
          name: 'n',
          data: { [JOB_TENANT_FIELD]: { scope: 'global' } },
          attemptsMade: 1,
        },
        () => Promise.reject(new Error('smtp down')),
      ),
    ).rejects.toThrow('smtp down');
    const span = otel.spans()[0];
    expect(span.status.code).toBe(2);
    expect(span.events[0].name).toBe('exception');
  });

  it('fails a job permanently, without retries, when its input is invalid', async () => {
    class Handler {
      process() {
        return Promise.reject(
          AppError.validation([{ field: 'to', description: 'bad' }]),
        );
      }
    }
    new BullmqWorkersService(
      {
        getProviders: () => [{ instance: new Handler(), metatype: Handler }],
      } as unknown as DiscoveryService,
      { get: () => QUEUE_NOTIFICATION } as unknown as Reflector,
      {
        get: () => undefined,
        getOrThrow: () => 'localhost',
      } as unknown as ConfigService,
      registry(),
    ).onApplicationBootstrap();
    const run = processors[0]({
      id: 'j3',
      name: 'send-notification',
      attemptsMade: 0,
      data: { [JOB_TENANT_FIELD]: { scope: 'global' } },
    });
    await expect(run).rejects.toMatchObject({ name: 'UnrecoverableError' });
  });
});
