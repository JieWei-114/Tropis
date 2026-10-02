import {
  currentTenant,
  runInTenant,
} from '../../../common/tenant/tenant.context';
import { toTenantId } from '../../../common/keyspace';
import { SpanKind, trace } from '@opentelemetry/api';
import type Pulsar from 'pulsar-client';
import { UNKNOWN_EVENT_SOURCE, type EventEnvelope } from '@tropis/shared';
import {
  captureLogs,
  installTracing,
  nextTick,
  TRACE_ID,
  TRACEPARENT,
} from '../../../common/observability/__tests__/harness';
import { createLogger } from '../../../common/observability/logger';
import { runInExtractedSpan } from '../../../common/observability/propagation';
import { runWithRequestContext } from '../../../common/observability/request-context';
import { PulsarMessagingAdapter } from '../adapters/pulsar/pulsar-messaging.adapter';
import {
  consumeEnveloped,
  decodeIncoming,
  encodeOutgoing,
} from '../messaging.envelope';
import type { MessageHandler } from '../messaging.port';
import { InMemoryBroker } from './in-memory-broker';

const TOPIC = 'user-events';

interface Seen {
  body: unknown;
  envelope: EventEnvelope;
  traceId: string | undefined;
}

function recordingHandler(seen: Seen[]): MessageHandler {
  const logger = createLogger('user');
  return (data, envelope) => {
    seen.push({
      body: JSON.parse(data.toString()) as unknown,
      envelope,
      traceId: trace.getActiveSpan()?.spanContext().traceId,
    });
    logger.info('event-consumed', 'consumed');
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await nextTick();
  if (!cond()) throw new Error('timed out');
}

/** Publishes as an HTTP handler would: inside the request's server span. */
function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return runInExtractedSpan(
    { traceparent: TRACEPARENT },
    'GET /api/users',
    { kind: SpanKind.SERVER, tenantId: 'acme' },
    fn,
  );
}

const outboxMessage = {
  eventId: 'row-1',
  eventType: 'identity.user.created',
  aggregateId: 'user-9',
  payload: { userId: 'user-9', tenantId: 'acme' },
  timestamp: Date.UTC(2026, 8, 30, 8, 15),
};

const outboxEvent = {
  id: 'row-1',
  type: 'identity.user.created',
  subject: 'user-9',
  tenantId: 'acme',
  time: '2026-09-30T08:15:00.000Z',
};

const otel = installTracing();
afterAll(() => otel.shutdown());
beforeEach(() => otel.reset());

describe('messaging trace propagation and envelope', () => {
  it('carries the trace from publish to consume through the fake broker', async () => {
    const { records } = captureLogs();
    const broker = new InMemoryBroker();
    const seen: Seen[] = [];
    await broker.subscribe(TOPIC, 'sub', recordingHandler(seen));

    await inRequest(() =>
      broker.publish(TOPIC, outboxMessage, { event: outboxEvent }),
    );
    await until(() => seen.length === 1);

    expect(seen[0].traceId).toBe(TRACE_ID);
    expect(seen[0].body).toEqual(outboxMessage);
    expect(seen[0].envelope).toMatchObject({
      specversion: '1.0',
      id: 'row-1',
      type: 'identity.user.created',
      subject: 'user-9',
      tenantid: 'acme',
      time: '2026-09-30T08:15:00.000Z',
      source: '/tropis/backend',
      datacontenttype: 'application/json',
      schemaversion: '1',
      data: outboxMessage,
    });
    expect(seen[0].envelope.traceparent).toMatch(
      new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`),
    );

    const consumed = records.find((r) => r.event === 'user.event-consumed');
    expect(consumed).toMatchObject({ trace_id: TRACE_ID, 'tenant.id': 'acme' });

    const spans = otel.spans();
    const producer = spans.find((s) => s.name === 'publish user-events');
    const consumer = spans.find((s) => s.name === 'process user-events');
    expect(producer?.kind).toBe(SpanKind.PRODUCER);
    expect(consumer?.kind).toBe(SpanKind.CONSUMER);
    expect(producer?.spanContext().traceId).toBe(TRACE_ID);
    expect(consumer?.spanContext().traceId).toBe(TRACE_ID);
    expect(consumer?.parentSpanContext?.spanId).toBe(
      producer?.spanContext().spanId,
    );
    expect(producer?.attributes).toMatchObject({
      'messaging.system': 'memory',
      'messaging.destination.name': 'user-events',
      'messaging.operation.type': 'send',
      'messaging.message.id': 'row-1',
      'tenant.id': 'acme',
    });
    expect(consumer?.attributes).toMatchObject({
      'messaging.operation.type': 'process',
      'messaging.destination.subscription.name': 'sub',
      'tenant.id': 'acme',
    });
    await broker.close();
  });

  it('keeps the wire body unchanged and puts the envelope in properties', async () => {
    const broker = new InMemoryBroker();
    await broker.publish(
      TOPIC,
      { events: [1] },
      {
        properties: { source: 'test' },
        event: { type: 'tracking.batch.received', tenantId: 't1', id: 'e-1' },
      },
    );
    const [sent] = broker.sent;
    expect(JSON.parse(sent.data.toString())).toEqual({ events: [1] });
    expect(sent.properties).toMatchObject({
      source: 'test',
      ce_specversion: '1.0',
      ce_id: 'e-1',
      ce_type: 'tracking.batch.received',
      ce_tenantid: 't1',
      ce_datacontenttype: 'application/json',
    });
    expect(sent.properties.ce_time).toMatch(/Z$/);
    await broker.close();
  });

  it('marks a failed consume on the consumer span and nacks', async () => {
    const broker = new InMemoryBroker({
      maxRedeliveries: 0,
      redeliveryDelayMs: 1,
    });
    await broker.subscribe(TOPIC, 'sub', () => {
      throw new Error('sink down');
    });
    await broker.publish(TOPIC, { n: 1 });
    await until(() => broker.sent.some((s) => s.topic.endsWith('-DLQ')));
    const dlq = broker.sent.find((s) => s.topic.endsWith('-DLQ'));
    expect(dlq?.properties.traceparent).toBeDefined();
    const consumer = otel.spans().find((s) => s.kind === SpanKind.CONSUMER);
    expect(consumer?.status.code).toBe(2);
    expect(consumer?.events.map((e) => e.name)).toContain('exception');
    await broker.close();
  });

  it('unwraps a structured-mode envelope and gives a foreign message a tenantless envelope', () => {
    const structured = {
      specversion: '1.0',
      id: 'x',
      source: '/other',
      type: 'billing.invoice.paid',
      time: '2026-01-01T00:00:00.000Z',
      datacontenttype: 'application/json',
      tenantid: 'acme',
      schemaversion: '2',
      traceparent: TRACEPARENT,
      data: { amount: 5 },
    };
    const decoded = decodeIncoming(Buffer.from(JSON.stringify(structured)), {});
    expect(JSON.parse(decoded.data.toString())).toEqual({ amount: 5 });
    expect(decoded.envelope).toEqual(structured);

    const foreign = decodeIncoming(
      Buffer.from(JSON.stringify(outboxMessage)),
      {},
    );
    expect(foreign.envelope.type).toBe('tropis.message.published');
    expect(foreign.envelope.source).toBe(UNKNOWN_EVENT_SOURCE);
    expect(foreign.envelope.tenantid).toBeUndefined();
    expect(JSON.parse(foreign.data.toString())).toEqual(outboxMessage);
  });

  it('leaves the tenant out of an event published outside a tenant scope', () => {
    const msg = encodeOutgoing(TOPIC, { any: 1 });
    expect(msg.envelope.tenantid).toBeUndefined();
    expect(msg.properties.ce_tenantid).toBeUndefined();
  });

  it('binds the tenant of the unit of work when the payload names none', () => {
    const msg = runWithRequestContext({ traceId: TRACE_ID }, () =>
      runInTenant(toTenantId('ctx-tenant'), () =>
        encodeOutgoing(TOPIC, { any: 1 }),
      ),
    );
    expect(msg.envelope.tenantid).toBe('ctx-tenant');
    expect(msg.properties.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-`));
  });
});

/** Just enough of the Pulsar client for the adapter: one topic, one consumer. */
function fakePulsar() {
  const sent: Array<{ data: Buffer; properties?: Record<string, string> }> = [];
  const queue: Pulsar.Message[] = [];
  let waiting: ((m: Pulsar.Message) => void) | null = null;
  let closed: (() => void) | null = null;
  const acked: Pulsar.Message[] = [];
  const toMessage = (m: {
    data: Buffer;
    properties?: Record<string, string>;
  }) =>
    ({
      getData: () => m.data,
      getProperties: () => m.properties ?? {},
    }) as unknown as Pulsar.Message;
  const client = {
    createProducer: () =>
      Promise.resolve({
        send: (m: { data: Buffer; properties?: Record<string, string> }) => {
          sent.push(m);
          const msg = toMessage(m);
          if (waiting) waiting(msg);
          else queue.push(msg);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      }),
    subscribe: () =>
      Promise.resolve({
        receive: () =>
          new Promise<Pulsar.Message>((resolve, reject) => {
            const next = queue.shift();
            if (next) return resolve(next);
            waiting = (m) => {
              waiting = null;
              resolve(m);
            };
            closed = () => reject(new Error('closed'));
          }),
        acknowledge: (m: Pulsar.Message) => {
          acked.push(m);
          return Promise.resolve();
        },
        negativeAcknowledge: () => undefined,
        close: () => {
          closed?.();
          return Promise.resolve();
        },
      }),
  };
  return { client: client as unknown as Pulsar.Client, sent, acked };
}

describe('Pulsar adapter propagation', () => {
  it('injects traceparent and the envelope into properties and continues the trace', async () => {
    const pulsar = fakePulsar();
    const adapter = new PulsarMessagingAdapter(pulsar.client);
    const seen: Seen[] = [];
    const sub = await adapter.subscribe(TOPIC, 'sub', recordingHandler(seen));

    await inRequest(() =>
      adapter.publish(TOPIC, outboxMessage, { event: outboxEvent }),
    );
    await until(() => pulsar.acked.length === 1);

    expect(pulsar.sent[0].properties).toMatchObject({
      ce_id: 'row-1',
      ce_type: 'identity.user.created',
      ce_tenantid: 'acme',
    });
    expect(pulsar.sent[0].properties?.traceparent).toMatch(
      new RegExp(`^00-${TRACE_ID}-`),
    );
    expect(JSON.parse(pulsar.sent[0].data.toString())).toEqual(outboxMessage);
    expect(seen[0].traceId).toBe(TRACE_ID);
    expect(seen[0].envelope.id).toBe('row-1');
    const consumer = otel.spans().find((s) => s.kind === SpanKind.CONSUMER);
    expect(consumer?.attributes['messaging.system']).toBe('pulsar');
    await sub.close();
    await adapter.close();
  });

  it('runs the consumer inside the envelope tenant, and unscoped without one', async () => {
    const seen: (string | undefined)[] = [];
    const handler: MessageHandler = () => {
      seen.push(currentTenant());
    };
    const body = Buffer.from('{}');
    const attrs = {
      ce_specversion: '1.0',
      ce_id: 'e1',
      ce_type: 'user.account.created',
    };
    await consumeEnveloped(
      'memory',
      TOPIC,
      'sub',
      body,
      {
        ...attrs,
        ce_tenantid: 'acme',
      },
      handler,
    );
    await consumeEnveloped('memory', TOPIC, 'sub', body, attrs, handler);
    await consumeEnveloped(
      'memory',
      TOPIC,
      'sub',
      body,
      {
        ...attrs,
        ce_tenantid: 'not a tenant',
      },
      handler,
    );
    expect(seen).toEqual(['acme', undefined, undefined]);
  });
});
