import { OnModuleDestroy } from '@nestjs/common';
import type Pulsar from 'pulsar-client';
import { createLogger } from '../../../../common/observability/logger';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import {
  deadLetterSubscription,
  deadLetterTopic,
  DEFAULT_REDELIVERY,
  redeliveryDelay,
  MESSAGING_ACK_TIMEOUT_MS,
  type MessagingAdapter,
  type MessageHandler,
  type MessageSubscription,
  type PublishOptions,
  type RedeliveryOptions,
  type SubscribeOptions,
} from '../../messaging.port';
import {
  consumeEnveloped,
  destinationName,
  publishEnveloped,
} from '../../messaging.envelope';
import { consumerLabels, consumerMetrics } from '../../messaging.metrics';
import { PulsarProbe } from '../../../connections/pulsar/pulsar.probe';

/** Namespace the logical topics live in. */
const PULSAR_NAMESPACE = 'persistent://public/default';

/**
 * A logical topic (`user-events`) as a Pulsar topic name; a name that is
 * already fully qualified (`persistent://…`) is used as it is.
 */
export function toPulsarTopic(topic: string): string {
  return topic.includes('://') ? topic : `${PULSAR_NAMESPACE}/${topic}`;
}

const SUBSCRIPTION_TYPE_MAP: Record<
  NonNullable<SubscribeOptions['type']>,
  Pulsar.SubscriptionType
> = {
  shared: 'Shared',
  key_shared: 'KeyShared',
  exclusive: 'Exclusive',
  failover: 'Failover',
};

/**
 * MessagingPort adapter backed by the Pulsar client. PulsarConnectionModule
 * owns the client lifecycle and graceful shutdown; this adapter owns only
 * producers and the consumers it created.
 *
 * - Logical topics map to `persistent://public/default/<topic>`, their
 *   dead-letter topic to `<that>-DLQ`.
 * - Producers are created lazily and cached per topic, with key-based
 *   batching so batched messages keep their ordering key.
 * - A published key becomes the partition and ordering key; a `key_shared`
 *   subscription delivers each key to one consumer, in order.
 * - subscribe() runs a receive loop per subscription: handler resolves → ack,
 *   handler throws → negativeAcknowledge, held back so the redelivery delay
 *   doubles per attempt; Pulsar dead-letters after maxRedeliveries into
 *   `<topic>-DLQ`, whose subscription deadLetterSubscription(<sub>) keeps it.
 * - a receive failure closes the consumer and settles `stopped`, so the
 *   owner subscribes again.
 * - The envelope attributes and trace context travel as message properties
 *   (messaging.envelope.ts); Pulsar copies them to the DLQ with the message.
 */
export class PulsarMessagingAdapter
  implements MessagingAdapter, OnModuleDestroy
{
  private readonly logger = createLogger('messaging');
  private readonly producers = new Map<string, Promise<Pulsar.Producer>>();
  private readonly probe: PulsarProbe;

  constructor(
    private readonly pulsar: Pulsar.Client,
    private readonly redelivery: RedeliveryOptions = DEFAULT_REDELIVERY,
  ) {
    this.probe = new PulsarProbe(pulsar);
  }

  async publish(
    topic: string,
    payload: Buffer | object,
    opts?: PublishOptions,
  ): Promise<void> {
    await publishEnveloped('pulsar', topic, payload, opts, async (message) => {
      const producer = await this.getProducer(topic);
      await producer.send({
        data: message.data,
        properties: message.properties,
        ...(opts?.key ? { partitionKey: opts.key, orderingKey: opts.key } : {}),
      });
    });
  }

  async subscribe(
    topic: string,
    subscription: string,
    handler: MessageHandler,
    opts?: SubscribeOptions,
  ): Promise<MessageSubscription> {
    const consumer = await this.pulsar.subscribe({
      topic: toPulsarTopic(topic),
      subscription,
      subscriptionType: SUBSCRIPTION_TYPE_MAP[opts?.type ?? 'shared'],
      // Poison-message protection. Without a dead-letter policy a message that
      // always throws (malformed JSON, a permanently rejecting sink) is
      // redelivered forever and blocks the subscription's progress. The
      // initial subscription is what keeps a dead-lettered message: a topic
      // without a subscription retains nothing.
      deadLetterPolicy: {
        maxRedeliverCount: this.redelivery.maxRedeliveries,
        deadLetterTopic: toPulsarTopic(deadLetterTopic(topic)),
        initialSubscriptionName: deadLetterSubscription(subscription),
      },
      // The first redelivery's delay; later ones are held longer before the
      // nack (holdBeforeNack), which doubles the delay each time.
      nAckRedeliverTimeoutMs: this.redelivery.redeliveryDelayMs,
      // Redeliver if a consumer takes the message and then dies without acking.
      ackTimeoutMs: MESSAGING_ACK_TIMEOUT_MS,
    });

    const labels = consumerLabels(
      'pulsar',
      destinationName(topic),
      subscription,
    );
    const held = new Set<NodeJS.Timeout>();
    let running = true;
    let inFlight: Promise<void> = Promise.resolve();
    let reportStopped: (err: unknown) => void = () => undefined;
    const stopped = new Promise<unknown>((resolve) => {
      reportStopped = resolve;
    });

    const nack = (msg: Pulsar.Message) => {
      const hold = this.holdBeforeNack(msg.getRedeliveryCount());
      if (msg.getRedeliveryCount() >= this.redelivery.maxRedeliveries) {
        consumerMetrics().deadLettered.inc(labels);
      }
      if (hold <= 0) {
        consumer.negativeAcknowledge(msg);
        return;
      }
      const timer = setTimeout(() => {
        held.delete(timer);
        if (running) consumer.negativeAcknowledge(msg);
      }, hold);
      held.add(timer);
    };

    const handle = async (msg: Pulsar.Message) => {
      try {
        await consumeEnveloped(
          'pulsar',
          topic,
          subscription,
          msg.getData(),
          msg.getProperties(),
          handler,
        );
      } catch (err) {
        this.logger.warn(
          'handler-failed',
          'Message handler failed; the broker redelivers, then dead-letters',
          {
            'messaging.system': 'pulsar',
            'messaging.destination.name': topic,
            'messaging.consumer.group.name': subscription,
            'messaging.retry.attempt': msg.getRedeliveryCount(),
          },
          err,
        );
        nack(msg);
        return;
      }
      await consumer.acknowledge(msg);
    };

    const loop = (async () => {
      while (running) {
        let msg: Pulsar.Message;
        try {
          msg = await consumer.receive();
        } catch (err) {
          // receive() rejects when the consumer is closed; anything else stops
          // this subscription, and its owner subscribes again.
          if (!running) return;
          running = false;
          this.logger.warn(
            'receive-failed',
            'Message receive failed; the subscription stops and is resubscribed',
            {
              'messaging.system': 'pulsar',
              'messaging.destination.name': topic,
              'messaging.consumer.group.name': subscription,
            },
            err,
          );
          await consumer.close().catch(() => undefined);
          reportStopped(err);
          return;
        }
        inFlight = handle(msg).catch((err: unknown) =>
          this.logger.warn(
            'ack-failed',
            'Message ack failed; the broker redelivers it after the ack timeout',
            {
              'messaging.system': 'pulsar',
              'messaging.destination.name': topic,
              'messaging.consumer.group.name': subscription,
            },
            err,
          ),
        );
        await inFlight;
      }
    })();

    return {
      stopped,
      close: async () => {
        running = false;
        // The handler in flight finishes and is acked before the consumer
        // closes; held nacks are dropped, so the broker redelivers those.
        await inFlight;
        for (const timer of held) clearTimeout(timer);
        held.clear();
        await consumer.close().catch(() => undefined);
        await loop;
      },
    };
  }

  /**
   * How long to keep a failed message before nacking it, so the redelivery
   * delay doubles per attempt (the broker adds nAckRedeliverTimeoutMs).
   * Kept below the ack timeout, which would otherwise redeliver it first.
   */
  private holdBeforeNack(redeliveryCount: number): number {
    const total = redeliveryDelay(this.redelivery, redeliveryCount);
    const hold = total - this.redelivery.redeliveryDelayMs;
    return Math.max(0, Math.min(hold, MESSAGING_ACK_TIMEOUT_MS - 5_000));
  }

  async close(): Promise<void> {
    const pending = [...this.producers.values()];
    this.producers.clear();
    await this.probe.close();
    await Promise.all(
      pending.map((p) =>
        p.then((producer) => producer.close()).catch(() => undefined),
      ),
    );
    // The Pulsar client itself is closed by PulsarConnectionModule.onApplicationShutdown,
    // which Nest runs after this hook.
  }

  async onModuleDestroy() {
    await this.close();
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('pulsar', () => this.probe.check());
  }

  private getProducer(topic: string): Promise<Pulsar.Producer> {
    const existing = this.producers.get(topic);
    if (existing) return existing;
    const created = this.pulsar
      .createProducer({
        topic: toPulsarTopic(topic),
        batchingType: 'KeyBasedBatching',
      })
      .catch((err) => {
        // Don't cache a failed producer — allow retry on the next publish.
        this.producers.delete(topic);
        throw err;
      });
    this.producers.set(topic, created);
    return created;
  }
}
