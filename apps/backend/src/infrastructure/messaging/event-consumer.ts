import { randomUUID } from 'crypto';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { EventEnvelope } from '@tropis/shared';
import type { DedupKey, TenantId } from '../../common/keyspace';
import { createLogger } from '../../common/observability/logger';
import { requireTenant } from '../../common/tenant/tenant.context';
import {
  CapabilityDisabledError,
  capabilityDown,
  capabilityUp,
  type CapabilityHealth,
  type HealthCheckable,
} from '../capability';
import { DEDUP, type DedupPort } from '../dedup/dedup.port';
import {
  MESSAGING,
  MESSAGING_ACK_TIMEOUT_MS,
  type MessageSubscription,
  type MessagingPort,
  type SubscribeOptions,
} from './messaging.port';

/**
 * How long a dedup claim is held while its handler runs. Below the ack
 * timeout: a pod killed mid-handler cannot release its claim, and the
 * redelivery that follows the ack timeout must find the claim expired, or
 * the event would be dropped as a duplicate.
 */
export const CONSUMER_CLAIM_TTL_SECONDS = 30;

/** How long a handled event stays marked as seen. */
export const CONSUMER_SEEN_TTL_SECONDS = 24 * 60 * 60;

if (CONSUMER_CLAIM_TTL_SECONDS * 1000 >= MESSAGING_ACK_TIMEOUT_MS) {
  throw new Error('CONSUMER_CLAIM_TTL_SECONDS must stay below the ack timeout');
}

/** One received event, decoded and bound to its tenant. */
export interface ConsumedEvent<T> {
  /** The message body, decoded from JSON. */
  data: T;
  envelope: EventEnvelope;
  /** The envelope's tenant, which the handler runs in. */
  tenantId: TenantId;
}

export interface ConsumerSpec<T> {
  topic: string;
  subscription: string;
  type?: SubscribeOptions['type'];
  /** Log module of the consumer. */
  module: string;
  handle(event: ConsumedEvent<T>): Promise<void>;
}

/** First resubscribe delay; doubles per failed attempt up to the cap. */
export const RESUBSCRIBE_BASE_MS = 1_000;
export const RESUBSCRIBE_MAX_MS = 30_000;

export type ConsumerState = 'starting' | 'running' | 'retrying' | 'disabled';

export interface ConsumerStatus {
  topic: string;
  subscription: string;
  state: ConsumerState;
  /** Failed subscribe attempts since the last success. */
  failures: number;
}

/** A consumer started by EventConsumer.start(). */
export interface ConsumerHandle {
  /** Stops consuming and stops resubscribing. */
  close(): Promise<void>;
}

export interface OnceOptions {
  /** How long the event stays marked as seen once handled. */
  seenTtlSeconds?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
  );
}

/**
 * The consumer side of messaging, once for every consumer:
 *
 * - start(): subscribes in the background and keeps the subscription alive:
 *   a failed subscribe is retried with exponential backoff
 *   (RESUBSCRIBE_BASE_MS up to RESUBSCRIBE_MAX_MS), and a subscription that
 *   stops on its own is resubscribed the same way. health() is down while
 *   any started consumer is not running, which the worker role's readiness
 *   requires (the `consumers` probe). Each message has its JSON body decoded
 *   and runs in the envelope's tenant (a message without one fails with
 *   TENANT_REQUIRED and is redelivered, then dead-lettered); an event whose
 *   data names another tenant than its envelope is dropped (acked);
 * - once() / onceEach(): claim-then-commit on dedup keys. Each key is
 *   claimed for CONSUMER_CLAIM_TTL_SECONDS under a token of this attempt
 *   before the work; on success the claims are extended to the seen window,
 *   on failure released and the error rethrown, so the redelivery retries
 *   instead of being skipped. Extend and release are owner-checked, so an
 *   attempt whose claim expired never touches the claim of the next one.
 */
@Injectable()
export class EventConsumer implements HealthCheckable, OnModuleDestroy {
  private readonly consumers = new Set<RunningConsumer>();

  constructor(
    @Inject(MESSAGING) private readonly messaging: MessagingPort,
    @Inject(DEDUP) private readonly dedup: DedupPort,
  ) {}

  start<T extends object>(spec: ConsumerSpec<T>): ConsumerHandle {
    const logger = createLogger(spec.module);
    const handler = async (_raw: Buffer, envelope: EventEnvelope) => {
      const data = envelope.data;
      if (!isRecord(data)) {
        throw new Error('Message body is not a JSON object');
      }
      const tenantId = requireTenant();
      if (typeof data.tenantId === 'string' && data.tenantId !== tenantId) {
        logger.warn(
          'event-tenant-mismatch',
          'Event data names another tenant than its envelope; dropped',
          { 'event.id': envelope.id },
        );
        return;
      }
      await spec.handle({ data: data as T, envelope, tenantId });
    };
    const running = new RunningConsumer(
      () =>
        this.messaging.subscribe(spec.topic, spec.subscription, handler, {
          type: spec.type ?? 'shared',
        }),
      { topic: spec.topic, subscription: spec.subscription },
      logger,
    );
    this.consumers.add(running);
    running.begin();
    return {
      close: async () => {
        this.consumers.delete(running);
        await running.close();
      },
    };
  }

  /** Every started consumer and whether it is receiving. */
  status(): ConsumerStatus[] {
    return [...this.consumers].map((c) => c.status());
  }

  /** Down while any started consumer is not subscribed; up with none. */
  health(): Promise<CapabilityHealth> {
    const waiting = this.status().filter(
      (c) => c.state !== 'running' && c.state !== 'disabled',
    );
    if (!waiting.length) return Promise.resolve(capabilityUp('consumers'));
    return Promise.resolve(
      capabilityDown(
        'consumers',
        `not subscribed: ${waiting.map((c) => `${c.subscription} (${c.state})`).join(', ')}`,
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    const all = [...this.consumers];
    this.consumers.clear();
    await Promise.all(all.map((c) => c.close()));
  }

  /** Runs `work` once per key; false when the key was already handled. */
  async once(
    key: DedupKey,
    work: () => Promise<void>,
    options: OnceOptions = {},
  ): Promise<boolean> {
    const fresh = await this.onceEach(
      [key],
      (k) => k,
      () => work(),
      options,
    );
    return fresh.length > 0;
  }

  /**
   * Runs `work` with the items whose key no earlier attempt handled; returns
   * them. Nothing runs when every item was handled already.
   */
  async onceEach<E>(
    items: readonly E[],
    keyOf: (item: E) => DedupKey,
    work: (fresh: E[]) => Promise<void>,
    options: OnceOptions = {},
  ): Promise<E[]> {
    if (!items.length) return [];
    const owner = randomUUID();
    const keys = items.map(keyOf);
    const claims = await this.dedup.claimMany(
      keys,
      CONSUMER_CLAIM_TTL_SECONDS,
      owner,
    );
    const fresh = items.filter((_, i) => claims[i]);
    const claimed = keys.filter((_, i) => claims[i]);
    if (!fresh.length) return [];
    try {
      await work(fresh);
    } catch (err) {
      await this.dedup
        .releaseMany(claimed, owner)
        .catch((releaseErr: unknown) =>
          createLogger('messaging').error(
            'dedup-release-failed',
            'Dedup claims not released; the redelivery is dropped as a duplicate until they expire',
            releaseErr,
          ),
        );
      throw err;
    }
    const seen = options.seenTtlSeconds ?? CONSUMER_SEEN_TTL_SECONDS;
    await this.dedup
      .extendMany(claimed, seen, owner)
      .catch((err: unknown) =>
        createLogger('messaging').warn(
          'dedup-extend-failed',
          'Seen markers not extended; a redelivery may be handled again',
          {},
          err,
        ),
      );
    return fresh;
  }
}

/** One started consumer: subscribes, and resubscribes when it stops. */
class RunningConsumer {
  private state: ConsumerState = 'starting';
  private failures = 0;
  private subscription: MessageSubscription | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private attempt: Promise<void> | null = null;

  constructor(
    private readonly subscribe: () => Promise<MessageSubscription>,
    private readonly target: { topic: string; subscription: string },
    private readonly logger: ReturnType<typeof createLogger>,
  ) {}

  status(): ConsumerStatus {
    return { ...this.target, state: this.state, failures: this.failures };
  }

  begin(): void {
    if (this.closed) return;
    this.attempt = this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.attempt;
    const sub = this.subscription;
    this.subscription = null;
    await sub?.close();
  }

  private fields() {
    return {
      'messaging.destination.name': this.target.topic,
      'messaging.consumer.group.name': this.target.subscription,
    };
  }

  private async connect(): Promise<void> {
    let sub: MessageSubscription;
    try {
      sub = await this.subscribe();
    } catch (err) {
      if (err instanceof CapabilityDisabledError) {
        this.state = 'disabled';
        this.logger.info(
          'consumer-disabled',
          'Messaging is disabled; consumer not started',
          this.fields(),
        );
        return;
      }
      this.failures += 1;
      this.state = 'retrying';
      const delay = this.delay();
      this.logger.warn(
        'consumer-subscribe-failed',
        'Subscribe failed; retrying',
        {
          ...this.fields(),
          'messaging.retry.attempt': this.failures,
          'messaging.retry.delay_ms': delay,
        },
        err,
      );
      this.retryAfter(delay);
      return;
    }
    if (this.closed) {
      await sub.close();
      return;
    }
    this.subscription = sub;
    this.failures = 0;
    this.state = 'running';
    this.logger.info('consumer-started', 'Consumer subscribed', this.fields());
    void sub.stopped?.then((reason) => {
      if (this.closed || this.subscription !== sub) return;
      this.subscription = null;
      this.state = 'retrying';
      this.failures += 1;
      this.logger.warn(
        'consumer-stopped',
        'Subscription stopped; resubscribing',
        this.fields(),
        reason,
      );
      this.retryAfter(this.delay());
    });
  }

  private delay(): number {
    return Math.min(
      RESUBSCRIBE_MAX_MS,
      RESUBSCRIBE_BASE_MS * 2 ** Math.max(0, this.failures - 1),
    );
  }

  private retryAfter(delayMs: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.begin();
    }, delayMs);
    this.timer.unref?.();
  }
}
