import { SpanKind, trace } from '@opentelemetry/api';
import {
  installTracing,
  nextTick,
  TRACE_ID,
  TRACEPARENT,
} from '../../../common/observability/__tests__/harness';
import { runInExtractedSpan } from '../../../common/observability/propagation';
import { KafkaMessagingAdapter } from '../adapters/kafka/kafka-messaging.adapter';

type Headers = Record<string, Buffer | string>;
interface Sent {
  topic: string;
  messages: Array<{ value: Buffer; headers?: Record<string, string> }>;
}
type EachMessage = (arg: {
  partition: number;
  message: { value: Buffer; headers: Headers; offset: string; key: null };
  heartbeat: () => Promise<void>;
}) => Promise<void>;

interface FakeConsumer {
  topics: string[];
  eachMessage?: EachMessage;
  listeners: Map<string, (event: unknown) => void>;
}

const sent: Sent[] = [];
const consumers: FakeConsumer[] = [];
const heartbeat = jest.fn(() => Promise.resolve());

/**
 * kafkajs replaced by an in-process fake: a send is delivered straight to
 * the running consumers of its topic, with headers as Buffers the way
 * kafkajs hands them over.
 */
jest.mock('kafkajs', () => ({
  logLevel: { ERROR: 1, WARN: 2 },
  Kafka: class {
    producer() {
      return {
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        send: async (batch: Sent) => {
          sent.push(batch);
          for (const c of consumers.filter((x) =>
            x.topics.includes(batch.topic),
          )) {
            for (const m of batch.messages) {
              const headers: Headers = {};
              for (const [k, v] of Object.entries(m.headers ?? {})) {
                headers[k] = Buffer.from(v);
              }
              await c.eachMessage?.({
                partition: 0,
                message: { value: m.value, headers, offset: '0', key: null },
                heartbeat,
              });
            }
          }
        },
      };
    }
    admin() {
      return {
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        createTopics: () => Promise.resolve(true),
        fetchOffsets: () => Promise.resolve([{ partitions: [] }]),
        fetchTopicOffsets: () => Promise.resolve([]),
        setOffsets: () => Promise.resolve(),
        describeCluster: () => Promise.resolve({}),
      };
    }
    consumer() {
      const c: FakeConsumer = { topics: [], listeners: new Map() };
      consumers.push(c);
      return {
        events: { CRASH: 'consumer.crash' },
        on: (event: string, fn: (e: unknown) => void) => {
          c.listeners.set(event, fn);
        },
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        subscribe: ({ topics }: { topics: string[] }) => {
          c.topics.push(...topics);
          return Promise.resolve();
        },
        run: ({ eachMessage }: { eachMessage: EachMessage }) => {
          c.eachMessage = eachMessage;
          return Promise.resolve();
        },
      };
    }
  },
}));

describe('Kafka adapter propagation', () => {
  const otel = installTracing();
  afterAll(() => otel.shutdown());

  it('injects traceparent and the envelope into headers and continues the trace', async () => {
    const adapter = new KafkaMessagingAdapter({
      brokers: ['x:9092'],
      clientId: 't',
    });
    const seen: Array<{
      traceId?: string;
      id: string;
      tenant?: string;
      body: unknown;
    }> = [];
    await adapter.subscribe('user-events', 'sub', (data, env) => {
      seen.push({
        traceId: trace.getActiveSpan()?.spanContext().traceId,
        id: env.id,
        tenant: env.tenantid,
        body: JSON.parse(data.toString()) as unknown,
      });
    });

    await runInExtractedSpan(
      { traceparent: TRACEPARENT },
      'request',
      { kind: SpanKind.SERVER },
      () =>
        adapter.publish(
          'user-events',
          {
            eventId: 'row-7',
            eventType: 'identity.user.updated',
            payload: { tenantId: 'acme' },
          },
          {
            event: {
              id: 'row-7',
              type: 'identity.user.updated',
              tenantId: 'acme',
            },
          },
        ),
    );
    await nextTick();

    const headers = sent[0].messages[0].headers ?? {};
    expect(sent[0].topic).toBe('user-events');
    expect(headers.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-`));
    expect(headers).toMatchObject({
      ce_id: 'row-7',
      ce_type: 'identity.user.updated',
      ce_tenantid: 'acme',
    });
    expect(seen).toEqual([
      {
        traceId: TRACE_ID,
        id: 'row-7',
        tenant: 'acme',
        body: {
          eventId: 'row-7',
          eventType: 'identity.user.updated',
          payload: { tenantId: 'acme' },
        },
      },
    ]);
    const consumer = otel.spans().find((s) => s.kind === SpanKind.CONSUMER);
    expect(consumer?.attributes).toMatchObject({
      'messaging.system': 'kafka',
      'messaging.destination.name': 'user-events',
      'messaging.consumer.group.name': 'sub',
    });
    await adapter.close();
  });

  it('heartbeats the group while a failed message waits to be retried', async () => {
    jest.useFakeTimers();
    heartbeat.mockClear();
    const adapter = new KafkaMessagingAdapter({
      brokers: ['x:9092'],
      clientId: 't',
      redelivery: {
        maxRedeliveries: 1,
        redeliveryDelayMs: 10_000,
        maxRedeliveryDelayMs: 10_000,
      },
    });
    let calls = 0;
    await adapter.subscribe('retry-events', 'sub', () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
    });
    const published = adapter.publish('retry-events', { n: 1 });
    await jest.advanceTimersByTimeAsync(10_500);
    await published;
    expect(calls).toBe(2);
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    jest.useRealTimers();
    await adapter.close();
  });

  it('reports a crashed consumer that does not restart as stopped', async () => {
    const adapter = new KafkaMessagingAdapter({
      brokers: ['x:9092'],
      clientId: 't',
    });
    const sub = await adapter.subscribe('crash-events', 'sub', () => undefined);
    const fake = consumers[consumers.length - 1];
    const crash = new Error('fatal');
    fake.listeners.get('consumer.crash')?.({
      payload: { error: crash, groupId: 'sub', restart: false },
    });
    await expect(sub.stopped).resolves.toBe(crash);
    await adapter.close();
  });
});
