/**
 * Broker-agnostic messaging port (hexagonal "port" side).
 *
 * Business code injects MESSAGE_BROKER and codes against this interface —
 * never against a concrete client (Pulsar today, possibly Kafka tomorrow).
 * The interface is deliberately minimal: it only covers what consumers in
 * this codebase actually use (fire-and-forget publish + shared-subscription
 * consume with ack-on-success / nack-on-throw semantics).
 *
 * Adapters live next to this file (see pulsar-broker.adapter.ts) and are
 * selected by the MESSAGE_BROKER env var in messaging.module.ts.
 */
export const MESSAGE_BROKER = 'MESSAGE_BROKER';

export interface PublishOptions {
  /** Optional string metadata attached to the message (broker headers/properties). */
  properties?: Record<string, string>;
}

export interface SubscribeOptions {
  /**
   * 'shared'    — competing consumers, per-message load balancing (default).
   * 'exclusive' — single consumer owns the subscription.
   * 'failover'  — one active consumer, others on standby.
   */
  type?: 'shared' | 'exclusive' | 'failover';
}

export interface MessageSubscription {
  /** Stops the receive loop and closes the underlying consumer. */
  close(): Promise<void>;
}

/**
 * Handler contract: resolve = ack, throw/reject = nack (the broker will
 * redeliver according to its own policy).
 */
export type MessageHandler = (data: Buffer) => Promise<void> | void;

export interface MessageBrokerPort {
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
