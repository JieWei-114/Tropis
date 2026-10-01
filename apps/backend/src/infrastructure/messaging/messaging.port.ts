import type { EventEnvelope } from '@tropis/shared';
import type { HealthCheckable } from '../capability';

/**
 * Messaging — publish/subscribe over a broker.
 *
 * Business code injects MESSAGING and codes against MessagingPort, never
 * against a concrete client. Topics are logical names (`user-events`); each
 * adapter maps them to its own naming. The interface covers what consumers
 * use: publish, and subscription-based consume with ack-on-success /
 * nack-on-throw. Consumers normally go through EventConsumer
 * (event-consumer.ts), which adds the decoding, tenant and dedup rules.
 *
 * Delivery contract shared by every adapter:
 *   - a handler that resolves acks the message;
 *   - a handler that throws is redelivered after an exponentially growing
 *     delay, up to a bounded number of redeliveries, after which the message
 *     goes to `<topic>-DLQ`, where it is kept for the subscription
 *     deadLetterSubscription(<subscription>) until an operator redrives it;
 *   - a new subscription starts at the messages published after subscribe()
 *     resolves (it does not replay history).
 *
 * Every message is described by an event envelope (CloudEvents 1.0, see
 * packages/shared/src/events/envelope.ts) and carries W3C Trace Context;
 * messaging.envelope.ts does both for every adapter. The body on the wire is
 * the published payload unchanged.
 *
 * Adapters live in adapters/<technology>/ and are selected by
 * MESSAGING_ADAPTER in messaging.module.ts.
 */
export const MESSAGING = Symbol('MESSAGING');

/**
 * A received message that is not acked within this window is redelivered.
 * Anything a handler holds for the duration of one attempt (a dedup claim)
 * must expire before it, or the redelivery of a crashed attempt would find
 * it still taken.
 */
export const MESSAGING_ACK_TIMEOUT_MS = 60_000;

/** Envelope attributes a publisher may set; the rest are derived. */
export interface EventAttributes {
  /** Stable across retries of the same event, so consumers can dedup. */
  id?: string;
  /** `<domain>.<entity>.<past-tense>`. */
  type?: string;
  subject?: string;
  tenantId?: string;
  schemaVersion?: string;
  source?: string;
  /** When the event happened (ISO 8601 UTC); the publish time when unset. */
  time?: string;
}

export interface PublishOptions {
  /** Optional string metadata attached to the message (broker headers/properties). */
  properties?: Record<string, string>;
  /**
   * Envelope attributes. Unset ones default: a new id, the publish time,
   * EVENT_TYPES.MESSAGE_PUBLISHED and the caller's tenant.
   */
  event?: EventAttributes;
  /**
   * Ordering key (the outbox passes the aggregate id). Messages with one key
   * reach a `key_shared` subscriber in publish order, one at a time: Pulsar
   * routes by it, Kafka partitions by it.
   */
  key?: string;
}

export interface SubscribeOptions {
  /**
   * 'shared'     — competing consumers, per-message load balancing (default);
   *                no ordering between messages.
   * 'key_shared' — competing consumers, but all messages of one key go to
   *                one consumer in order; use it for projections that must
   *                not apply an older event after a newer one.
   * 'exclusive'  — single consumer owns the subscription.
   * 'failover'   — one active consumer, others on standby.
   */
  type?: 'shared' | 'key_shared' | 'exclusive' | 'failover';
}

export interface MessageSubscription {
  /** Stops the receive loop and closes the underlying consumer. */
  close(): Promise<void>;
  /**
   * Settles when the subscription stops receiving on its own (the consumer
   * crashed or its receive loop failed), never after close(). The caller
   * subscribes again.
   */
  readonly stopped?: Promise<unknown>;
}

/**
 * Handler contract: resolve = ack, throw/reject = nack (the adapter
 * redelivers, then dead-letters). `data` is the message body as published;
 * `envelope` describes it (its `data` is the decoded body).
 */
export type MessageHandler = (
  data: Buffer,
  envelope: EventEnvelope,
) => Promise<void> | void;

export interface MessagingPort {
  /**
   * Publish a payload to a topic. Objects are JSON-serialized; Buffers are
   * sent as-is. Producers/connections are managed (and cached) by the adapter.
   */
  publish(
    topic: string,
    payload: Buffer | object,
    opts?: PublishOptions,
  ): Promise<void>;

  /**
   * Subscribe to a topic and process messages one at a time. The handler
   * resolving acks the message; throwing nacks it for redelivery.
   */
  subscribe(
    topic: string,
    subscription: string,
    handler: MessageHandler,
    opts?: SubscribeOptions,
  ): Promise<MessageSubscription>;

  /** Closes all producers/consumers created through this port. */
  close(): Promise<void>;
}

/** What every adapter implements: the port plus a health probe. */
export interface MessagingAdapter extends MessagingPort, HealthCheckable {}

/** Redelivery policy shared by the adapters. */
export interface RedeliveryOptions {
  /** Redeliveries after the first failed attempt before dead-lettering. */
  maxRedeliveries: number;
  /** Delay before the first redelivery; each later one doubles it. */
  redeliveryDelayMs: number;
  /** Ceiling of the doubled delay; the delay stays fixed when unset. */
  maxRedeliveryDelayMs?: number;
}

/**
 * About three minutes of retries (1+2+4+8+16 s, then 30 s each) before a
 * message is dead-lettered, so a broker-side or sink outage of that length
 * loses nothing.
 */
export const DEFAULT_REDELIVERY: RedeliveryOptions = {
  maxRedeliveries: 10,
  redeliveryDelayMs: 1_000,
  maxRedeliveryDelayMs: 30_000,
};

/** Delay before redelivery number `redelivery` (0 = the first). */
export function redeliveryDelay(
  options: RedeliveryOptions,
  redelivery: number,
): number {
  const ceiling = options.maxRedeliveryDelayMs ?? options.redeliveryDelayMs;
  const delay = options.redeliveryDelayMs * 2 ** Math.max(0, redelivery);
  return Math.min(Math.max(ceiling, options.redeliveryDelayMs), delay);
}

export const deadLetterTopic = (topic: string): string => `${topic}-DLQ`;

/**
 * The subscription that holds a subscription's dead-lettered messages on
 * deadLetterTopic(topic). It exists from the first subscribe, so nothing
 * dead-lettered before an operator looks is lost; the devtools
 * `messaging-dlq` tool reads and redrives it.
 */
export const deadLetterSubscription = (subscription: string): string =>
  `${subscription}-DLQ`;

export const MESSAGING_ADAPTERS = ['pulsar', 'kafka', 'disabled'] as const;
export type MessagingAdapterName = (typeof MESSAGING_ADAPTERS)[number];
