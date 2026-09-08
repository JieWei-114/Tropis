import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Pulsar from 'pulsar-client';
import { PULSAR_CLIENT } from '../pulsar/pulsar.module';
import {
  MessageBrokerPort,
  MessageHandler,
  MessageSubscription,
  PublishOptions,
  SubscribeOptions,
} from './message-broker.port';

/** Redelivery attempts before a message is routed to `<topic>-DLQ`. */
const MAX_REDELIVERIES = 5;
/** Delay before a nacked message comes back — avoids a hot retry loop. */
const NACK_REDELIVER_DELAY_MS = 5_000;
/** Redeliver if a consumer holds a message this long without acking. */
const ACK_TIMEOUT_MS = 60_000;

const SUBSCRIPTION_TYPE_MAP: Record<
  NonNullable<SubscribeOptions['type']>,
  Pulsar.SubscriptionType
> = {
  shared: 'Shared',
  exclusive: 'Exclusive',
  failover: 'Failover',
};

/**
 * MessageBrokerPort adapter backed by the Pulsar client. PulsarModule owns the
 * client lifecycle and graceful shutdown; this adapter owns only producers.
 *
 * - Producers are created lazily and cached per topic.
 * - subscribe() runs a receive loop per subscription: handler resolves → ack,
 *   handler throws → negativeAcknowledge (Pulsar redelivers).
 */
@Injectable()
export class PulsarBrokerAdapter implements MessageBrokerPort, OnModuleDestroy {
  private readonly logger = new Logger(PulsarBrokerAdapter.name);
  private readonly producers = new Map<string, Promise<Pulsar.Producer>>();

  constructor(@Inject(PULSAR_CLIENT) private readonly pulsar: Pulsar.Client) {}

  async publish(
    topic: string,
    payload: Buffer | object,
    opts?: PublishOptions,
  ): Promise<void> {
    const producer = await this.getProducer(topic);
    await producer.send({
      data: Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(JSON.stringify(payload)),
      properties: opts?.properties,
    });
  }

  async subscribe(
    topic: string,
    subscription: string,
    handler: MessageHandler,
    opts?: SubscribeOptions,
  ): Promise<MessageSubscription> {
    const consumer = await this.pulsar.subscribe({
      topic,
      subscription,
      subscriptionType: SUBSCRIPTION_TYPE_MAP[opts?.type ?? 'shared'],
      // Poison-message protection. Without a dead-letter policy a message that
      // always throws (malformed JSON, a permanently rejecting sink) is
      // redelivered forever and blocks the subscription's progress.
      deadLetterPolicy: {
        maxRedeliverCount: MAX_REDELIVERIES,
        deadLetterTopic: `${topic}-DLQ`,
      },
      // Back off between redeliveries instead of hot-looping on a failure.
      nAckRedeliverTimeoutMs: NACK_REDELIVER_DELAY_MS,
      // Redeliver if a consumer takes the message and then dies without acking.
      ackTimeoutMs: ACK_TIMEOUT_MS,
    });

    let running = true;
    const loop = (async () => {
      while (running) {
        let msg: Pulsar.Message;
        try {
          msg = await consumer.receive();
        } catch {
          // receive() rejects when the consumer is closed — exit the loop.
          if (running) {
            this.logger.warn(`Receive failed on ${topic} — stopping loop`);
          }
          return;
        }
        try {
          await handler(msg.getData());
          await consumer.acknowledge(msg);
        } catch (err) {
          // nack → redelivered after NACK_REDELIVER_DELAY_MS, then routed to
          // <topic>-DLQ once MAX_REDELIVERIES is exhausted.
          this.logger.error(
            `Handler failed on ${topic} (will retry, then DLQ): ${(err as Error).message}`,
          );
          consumer.negativeAcknowledge(msg);
        }
      }
    })();

    return {
      close: async () => {
        running = false;
        await consumer.close().catch(() => undefined);
        await loop;
      },
    };
  }

  async close(): Promise<void> {
    const pending = [...this.producers.values()];
    this.producers.clear();
    await Promise.all(
      pending.map((p) =>
        p.then((producer) => producer.close()).catch(() => undefined),
      ),
    );
    // The Pulsar client itself is closed by PulsarModule (closePulsarClient).
  }

  async onModuleDestroy() {
    await this.close();
  }

  private getProducer(topic: string): Promise<Pulsar.Producer> {
    const existing = this.producers.get(topic);
    if (existing) return existing;
    const created = this.pulsar.createProducer({ topic }).catch((err) => {
      // Don't cache a failed producer — allow retry on the next publish.
      this.producers.delete(topic);
      throw err;
    });
    this.producers.set(topic, created);
    return created;
  }
}
