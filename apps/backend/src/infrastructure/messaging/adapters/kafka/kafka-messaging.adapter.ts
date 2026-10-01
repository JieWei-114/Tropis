import { OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../../../common/observability/logger';
import {
  Kafka,
  logLevel,
  type Admin,
  type IHeaders,
  type KafkaMessage,
  type LogEntry,
  type Producer,
} from 'kafkajs';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import {
  deadLetterSubscription,
  deadLetterTopic,
  DEFAULT_REDELIVERY,
  redeliveryDelay,
  type MessagingAdapter,
  type MessageHandler,
  type MessageSubscription,
  type PublishOptions,
  type RedeliveryOptions,
} from '../../messaging.port';
import {
  consumeEnveloped,
  destinationName,
  headersToStrings,
  publishEnveloped,
} from '../../messaging.envelope';
import { consumerLabels, consumerMetrics } from '../../messaging.metrics';

export interface KafkaMessagingOptions {
  brokers: string[];
  clientId: string;
  redelivery?: RedeliveryOptions;
}

const TOPIC_PATTERN = /^[A-Za-z0-9._-]{1,249}$/;

/**
 * A logical topic as a Kafka topic name: the name itself; a fully qualified
 * Pulsar-style name (`persistent://tenant/namespace/name`) becomes
 * `tenant.namespace.name`.
 */
export function toKafkaTopic(topic: string): string {
  const mapped = topic
    .replace(/^(non-)?persistent:\/\//, '')
    .replace(/\//g, '.');
  if (!TOPIC_PATTERN.test(mapped)) {
    throw new Error(
      `Topic ${JSON.stringify(topic)} is not a valid Kafka topic`,
    );
  }
  return mapped;
}

const COORDINATOR_RETRIES = 20;
const COORDINATOR_RETRY_DELAY_MS = 500;

/**
 * Retries errors Kafka marks retriable. The group coordinator answers
 * "not available" / "not the correct coordinator" while __consumer_offsets
 * is still being created, and the admin client does not retry those itself.
 */
async function retryRetriable<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const retriable = (err as { retriable?: boolean }).retriable === true;
      if (!retriable || attempt >= COORDINATOR_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, COORDINATOR_RETRY_DELAY_MS));
    }
  }
}

/** Longest wait between heartbeats while a message waits to be retried. */
const RETRY_HEARTBEAT_MS = 3_000;

const kafkaLogger = createLogger('messaging');

/** Routes kafkajs log entries through the logger port. */
export function kafkaLogCreator(): (entry: LogEntry) => void {
  return ({ namespace, level, log }) => {
    const { message, timestamp: _timestamp, ...extra } = log;
    const fields = { 'kafka.namespace': namespace, ...extra };
    if (level === logLevel.ERROR) {
      kafkaLogger.error('kafka-client', message, undefined, fields);
    } else if (level === logLevel.WARN) {
      kafkaLogger.warn('kafka-client', message, fields);
    } else {
      kafkaLogger.debug('kafka-client', message, fields);
    }
  };
}

class SubscriptionClosedError extends Error {
  constructor() {
    super('Subscription closed during redelivery');
  }
}

/**
 * MessagingPort adapter backed by kafkajs.
 *
 * Semantics, compared with the Pulsar adapter:
 * - subscription → consumer group. Kafka balances partitions, not messages:
 *   `shared` and `key_shared` consumers compete per partition, and
 *   `exclusive`/`failover` also map to a plain group (Kafka cannot refuse a
 *   second member). A published key is the record key, so one key stays on
 *   one partition and in order, which is what `key_shared` promises.
 * - nack → the adapter redelivers in-process: it waits (doubling the delay
 *   per attempt, heartbeating the group meanwhile so the member is not
 *   evicted) and calls the handler again, up to maxRedeliveries, then
 *   publishes the
 *   message (value and headers, plus x-dlq-* headers) to `<topic>-DLQ` and
 *   commits. While a message is retrying its partition does not advance
 *   (Pulsar keeps delivering other messages). The retry count lives in
 *   memory: if the process dies mid-retry the offset is uncommitted, the
 *   message is redelivered to another member and its count starts again.
 * - a new group starts at the end of the topic, pinned when subscribe()
 *   resolves (like a new Pulsar subscription at Latest), so messages
 *   published after subscribe() are never skipped while the group joins.
 * - topics (and their DLQ) are created on first use with broker defaults;
 *   the dead-letter group deadLetterSubscription(<sub>) is pinned to the DLQ
 *   end at subscribe, so it reads every message dead-lettered since.
 * - a consumer that crashes without restarting settles `stopped`.
 * - the envelope attributes and trace context travel as record headers
 *   (messaging.envelope.ts) and are copied to the DLQ record.
 */
export class KafkaMessagingAdapter
  implements MessagingAdapter, OnModuleDestroy
{
  private readonly logger = createLogger('messaging');
  private readonly kafka: Kafka;
  private readonly redelivery: RedeliveryOptions;
  private producer: Promise<Producer> | null = null;
  private admin: Promise<Admin> | null = null;
  private readonly knownTopics = new Map<string, Promise<void>>();
  private readonly subscriptions = new Set<MessageSubscription>();

  constructor(options: KafkaMessagingOptions) {
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers,
      logLevel: logLevel.WARN,
      logCreator: kafkaLogCreator,
    });
    this.redelivery = options.redelivery ?? DEFAULT_REDELIVERY;
  }

  async publish(
    topic: string,
    payload: Buffer | object,
    opts?: PublishOptions,
  ): Promise<void> {
    const kafkaTopic = toKafkaTopic(topic);
    await publishEnveloped('kafka', topic, payload, opts, async (message) => {
      await this.ensureTopics([kafkaTopic]);
      await this.send(kafkaTopic, {
        key: opts?.key ? Buffer.from(opts.key) : null,
        value: message.data,
        headers: message.properties,
      });
    });
  }

  async subscribe(
    topic: string,
    subscription: string,
    handler: MessageHandler,
  ): Promise<MessageSubscription> {
    const kafkaTopic = toKafkaTopic(topic);
    const dlqTopic = toKafkaTopic(deadLetterTopic(topic));
    await this.ensureTopics([kafkaTopic, dlqTopic]);
    await this.pinNewGroupToEnd(subscription, kafkaTopic);

    await this.pinNewGroupToEnd(deadLetterSubscription(subscription), dlqTopic);

    const consumer = this.kafka.consumer({ groupId: subscription });
    const labels = consumerLabels(
      'kafka',
      destinationName(topic),
      subscription,
    );
    let closing = false;
    let wake: (() => void) | null = null;
    let reportStopped: (err: unknown) => void = () => undefined;
    const stopped = new Promise<unknown>((resolve) => {
      reportStopped = resolve;
    });

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });

    const waitBeforeRetry = async (
      attempt: number,
      heartbeat: () => Promise<void>,
    ) => {
      const until = Date.now() + redeliveryDelay(this.redelivery, attempt);
      while (!closing && Date.now() < until) {
        await sleep(Math.min(RETRY_HEARTBEAT_MS, until - Date.now()));
        if (!closing) await heartbeat();
      }
    };

    consumer.on(consumer.events.CRASH, ({ payload }) => {
      if (payload.restart || closing) return;
      this.logger.error(
        'consumer-crashed',
        'Kafka consumer crashed and will not restart; the subscription stops and is resubscribed',
        payload.error,
        {
          'messaging.system': 'kafka',
          'messaging.destination.name': kafkaTopic,
          'messaging.consumer.group.name': subscription,
        },
      );
      reportStopped(payload.error);
    });

    await consumer.connect();
    try {
      await consumer.subscribe({ topics: [kafkaTopic], fromBeginning: false });
      await consumer.run({
        eachMessage: async ({ partition, message, heartbeat }) => {
          for (let attempt = 0; ; attempt += 1) {
            if (closing) throw new SubscriptionClosedError();
            try {
              await consumeEnveloped(
                'kafka',
                kafkaTopic,
                subscription,
                message.value ?? Buffer.alloc(0),
                headersToStrings(message.headers),
                handler,
              );
              return;
            } catch (err) {
              if (attempt >= this.redelivery.maxRedeliveries) {
                await this.deadLetter(
                  dlqTopic,
                  kafkaTopic,
                  partition,
                  message,
                  err,
                );
                consumerMetrics().deadLettered.inc(labels);
                return;
              }
              this.logger.warn(
                'handler-failed',
                'Message handler failed; retrying before dead-lettering',
                {
                  'messaging.system': 'kafka',
                  'messaging.destination.name': kafkaTopic,
                  'messaging.retry.attempt': attempt,
                },
                err,
              );
              await waitBeforeRetry(attempt, heartbeat);
            }
          }
        },
      });
    } catch (err) {
      await consumer.disconnect().catch(() => undefined);
      throw err;
    }

    const handle: MessageSubscription = {
      stopped,
      close: async () => {
        if (closing) return;
        // Throwing out of eachMessage (not returning) keeps the in-flight
        // offset uncommitted, so the message is redelivered, not lost.
        closing = true;
        (wake as (() => void) | null)?.();
        this.subscriptions.delete(handle);
        await consumer.disconnect().catch(() => undefined);
      },
    };
    this.subscriptions.add(handle);
    return handle;
  }

  async close(): Promise<void> {
    await Promise.all([...this.subscriptions].map((s) => s.close()));
    const producer = this.producer;
    const admin = this.admin;
    this.producer = null;
    this.admin = null;
    await Promise.all([
      producer?.then((p) => p.disconnect()).catch(() => undefined),
      admin?.then((a) => a.disconnect()).catch(() => undefined),
    ]);
  }

  async onModuleDestroy() {
    await this.close();
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('kafka', async () => {
      const admin = await this.getAdmin();
      await admin.describeCluster();
    });
  }

  private async deadLetter(
    dlqTopic: string,
    sourceTopic: string,
    partition: number,
    message: KafkaMessage,
    err: unknown,
  ): Promise<void> {
    this.logger.error(
      'message-dead-lettered',
      'Message handler failed after all redeliveries; routing to the dead-letter topic',
      err,
      {
        'messaging.system': 'kafka',
        'messaging.destination.name': sourceTopic,
        'messaging.dlq.name': dlqTopic,
        'messaging.retry.max': this.redelivery.maxRedeliveries,
      },
    );
    const headers: IHeaders = {
      ...(message.headers ?? {}),
      'x-dlq-original-topic': sourceTopic,
      'x-dlq-original-partition': String(partition),
      'x-dlq-original-offset': message.offset,
      'x-dlq-error': err instanceof Error ? err.message : String(err),
    };
    await this.send(dlqTopic, {
      key: message.key,
      value: message.value,
      headers,
    });
  }

  private async send(
    topic: string,
    message: { key?: Buffer | null; value: Buffer | null; headers?: IHeaders },
  ): Promise<void> {
    const producer = await this.getProducer();
    await producer.send({ topic, messages: [message] });
  }

  /**
   * A group with no committed offsets gets them set to the current end of
   * each partition, so it consumes exactly what is published from now on.
   * Skipped when offsets exist (the group resumes where it stopped) or when
   * the group is already running elsewhere.
   */
  private async pinNewGroupToEnd(
    groupId: string,
    topic: string,
  ): Promise<void> {
    const admin = await this.getAdmin();
    const [committed] = await retryRetriable(() =>
      admin.fetchOffsets({ groupId, topics: [topic] }),
    );
    const hasOffsets = committed?.partitions.some((p) => p.offset !== '-1');
    if (hasOffsets) return;
    const ends = await admin.fetchTopicOffsets(topic);
    try {
      await admin.setOffsets({
        groupId,
        topic,
        partitions: ends.map((p) => ({
          partition: p.partition,
          offset: p.high,
        })),
      });
    } catch (err) {
      this.logger.warn(
        'group-pin-failed',
        'Could not pin a new consumer group to the topic end',
        {
          'messaging.system': 'kafka',
          'messaging.consumer.group.name': groupId,
          'messaging.destination.name': topic,
        },
        err,
      );
    }
  }

  private ensureTopics(topics: string[]): Promise<void> {
    return Promise.all(
      topics.map((topic) => {
        const known = this.knownTopics.get(topic);
        if (known) return known;
        const created = this.getAdmin()
          .then((admin) =>
            admin.createTopics({ topics: [{ topic }], waitForLeaders: true }),
          )
          .then(() => undefined)
          .catch((err) => {
            this.knownTopics.delete(topic);
            throw err;
          });
        this.knownTopics.set(topic, created);
        return created;
      }),
    ).then(() => undefined);
  }

  private getProducer(): Promise<Producer> {
    if (!this.producer) {
      const producer = this.kafka.producer({ allowAutoTopicCreation: false });
      this.producer = producer
        .connect()
        .then(() => producer)
        .catch((err) => {
          this.producer = null;
          throw err;
        });
    }
    return this.producer;
  }

  private getAdmin(): Promise<Admin> {
    if (!this.admin) {
      const admin = this.kafka.admin();
      this.admin = admin
        .connect()
        .then(() => admin)
        .catch((err) => {
          this.admin = null;
          throw err;
        });
    }
    return this.admin;
  }
}
