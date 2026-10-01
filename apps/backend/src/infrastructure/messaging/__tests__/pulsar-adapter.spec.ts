import type Pulsar from 'pulsar-client';
import { PulsarMessagingAdapter } from '../adapters/pulsar/pulsar-messaging.adapter';
import { encodeOutgoing } from '../messaging.envelope';
import { MESSAGING_ACK_TIMEOUT_MS } from '../messaging.port';

interface FakeMessage {
  getData(): Buffer;
  getProperties(): Record<string, string>;
  getRedeliveryCount(): number;
}

function message(redeliveryCount = 0): FakeMessage {
  const out = encodeOutgoing('t', { n: 1 }, { event: { tenantId: 'acme' } });
  return {
    getData: () => out.data,
    getProperties: () => out.properties,
    getRedeliveryCount: () => redeliveryCount,
  };
}

/** A consumer whose receive() hands out queued messages, then blocks. */
function fakeConsumer() {
  const queue: Array<FakeMessage | Error> = [];
  let waiting: ((m: FakeMessage | Error) => void) | null = null;
  let closed = false;
  const consumer = {
    receive: jest.fn(
      () =>
        new Promise<FakeMessage>((resolve, reject) => {
          const take = (m: FakeMessage | Error) =>
            m instanceof Error ? reject(m) : resolve(m);
          const next = queue.shift();
          if (next) take(next);
          else waiting = take;
        }),
    ),
    acknowledge: jest.fn(() => Promise.resolve(null)),
    negativeAcknowledge: jest.fn(),
    close: jest.fn(() => {
      closed = true;
      waiting?.(new Error('AlreadyClosed'));
      waiting = null;
      return Promise.resolve(null);
    }),
  };
  const push = (m: FakeMessage | Error) => {
    if (closed) return;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(m);
    } else queue.push(m);
  };
  return { consumer, push };
}

function adapterWith(consumer: unknown) {
  const subscribe = jest.fn(() => Promise.resolve(consumer));
  const client = { subscribe } as unknown as Pulsar.Client;
  const adapter = new PulsarMessagingAdapter(client, {
    maxRedeliveries: 5,
    redeliveryDelayMs: 1_000,
    maxRedeliveryDelayMs: 30_000,
  });
  return { adapter, subscribe };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('PulsarMessagingAdapter', () => {
  afterEach(() => jest.useRealTimers());

  it('creates the dead-letter subscription with the consumer, so the DLQ keeps what it receives', async () => {
    const { consumer } = fakeConsumer();
    const { adapter, subscribe } = adapterWith(consumer);
    const sub = await adapter.subscribe('user-events', 'user-sub', () => {});
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        deadLetterPolicy: {
          maxRedeliverCount: 5,
          deadLetterTopic: 'persistent://public/default/user-events-DLQ',
          initialSubscriptionName: 'user-sub-DLQ',
        },
        nAckRedeliverTimeoutMs: 1_000,
      }),
    );
    await sub.close();
  });

  it('holds a failed message longer on each redelivery before nacking it', async () => {
    jest.useFakeTimers();
    const { consumer, push } = fakeConsumer();
    const { adapter } = adapterWith(consumer);
    const sub = await adapter.subscribe('t', 's', () => {
      throw new Error('sink down');
    });

    push(message(0));
    await jest.advanceTimersByTimeAsync(0);
    expect(consumer.negativeAcknowledge).toHaveBeenCalledTimes(1);

    push(message(3));
    await jest.advanceTimersByTimeAsync(6_999);
    expect(consumer.negativeAcknowledge).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(consumer.negativeAcknowledge).toHaveBeenCalledTimes(2);

    push(message(9));
    await jest.advanceTimersByTimeAsync(MESSAGING_ACK_TIMEOUT_MS);
    expect(consumer.negativeAcknowledge).toHaveBeenCalledTimes(3);
    await sub.close();
  });

  it('stops and settles `stopped` when receive fails', async () => {
    const { consumer, push } = fakeConsumer();
    const { adapter } = adapterWith(consumer);
    const sub = await adapter.subscribe('t', 's', () => {});
    const failure = new Error('connection reset');
    push(failure);
    await expect(sub.stopped).resolves.toBe(failure);
    expect(consumer.close).toHaveBeenCalled();
  });

  it('lets the handler in flight finish and ack before closing the consumer', async () => {
    const { consumer, push } = fakeConsumer();
    const { adapter } = adapterWith(consumer);
    let finish: () => void = () => undefined;
    const sub = await adapter.subscribe(
      't',
      's',
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    push(message());
    await flush();

    const closing = sub.close();
    await flush();
    expect(consumer.close).not.toHaveBeenCalled();

    finish();
    await closing;
    expect(consumer.acknowledge).toHaveBeenCalledTimes(1);
    expect(consumer.close).toHaveBeenCalled();
    expect(consumer.acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
      consumer.close.mock.invocationCallOrder[0],
    );
  });
});
