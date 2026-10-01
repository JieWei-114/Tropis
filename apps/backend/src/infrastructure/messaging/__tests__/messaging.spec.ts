import { CapabilityDisabledError } from '../../capability';
import { DisabledMessagingAdapter } from '../adapters/disabled/disabled-messaging.adapter';
import { toKafkaTopic } from '../adapters/kafka/kafka-messaging.adapter';
import type { MessagingPort } from '../messaging.port';
import { toPulsarTopic } from '../adapters/pulsar/pulsar-messaging.adapter';
import { InMemoryBroker } from './in-memory-broker';
import { describeMessagingPort } from './messaging.conformance';

const redelivery = {
  maxRedeliveries: 2,
  redeliveryDelayMs: 100,
  maxRedeliveryDelayMs: 400,
};

describeMessagingPort('in-memory fake', {
  redelivery,
  make: () => new InMemoryBroker(redelivery),
  deliveryTimeoutMs: 1_000,
});

describe('toPulsarTopic', () => {
  it('maps a logical topic into the default namespace', () => {
    expect(toPulsarTopic('user-events')).toBe(
      'persistent://public/default/user-events',
    );
    expect(toPulsarTopic('persistent://t/ns/x')).toBe('persistent://t/ns/x');
  });
});

describe('toKafkaTopic', () => {
  it('uses logical names as they are and maps Pulsar-style names', () => {
    expect(toKafkaTopic('user-events')).toBe('user-events');
    expect(toKafkaTopic('persistent://public/default/user-events')).toBe(
      'public.default.user-events',
    );
    expect(toKafkaTopic('persistent://public/default/user-events-DLQ')).toBe(
      'public.default.user-events-DLQ',
    );
    expect(toKafkaTopic('plain-topic')).toBe('plain-topic');
    expect(() => toKafkaTopic('bad topic')).toThrow();
  });
});

describe('DisabledMessagingAdapter', () => {
  it('rejects publish/subscribe and reports disabled', async () => {
    const broker = new DisabledMessagingAdapter();
    const port: MessagingPort = broker;
    await expect(port.publish('t', {})).rejects.toBeInstanceOf(
      CapabilityDisabledError,
    );
    await expect(
      port.subscribe('t', 's', () => undefined),
    ).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(port.close()).resolves.toBeUndefined();
    expect((await broker.health()).status).toBe('disabled');
  });
});
