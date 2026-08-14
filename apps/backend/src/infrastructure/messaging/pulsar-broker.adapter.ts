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

const SUBSCRIPTION_TYPE_MAP: Record<
  NonNullable<SubscribeOptions['type']>,
  Pulsar.SubscriptionType
> = {
  shared: 'Shared',
  exclusive: 'Exclusive',
  failover: 'Failover',
};

/**
 * MessageBrokerPort adapter backed by the existing Pulsar client
 * (PulsarModule still owns the client lifecycle + graceful shutdown).
 *
 * - Producers are created lazily and cached per topic (same pattern the
 *   outbox relay used before this abstraction existed).
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
          this.logger.error(
            `Handler failed on ${topic}: ${(err as Error).message}`,
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
