import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  USER_EVENTS,
  USER_TOPIC,
  USER_PULSAR_SUBSCRIPTION,
} from '../constants/user.constants';
import { UserStatus } from '../schemas/user.schema';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { MESSAGE_BROKER } from '../../../infrastructure/messaging/message-broker.port';
import type {
  MessageBrokerPort,
  MessageSubscription,
} from '../../../infrastructure/messaging/message-broker.port';
import { SearchService } from '../../../infrastructure/elasticsearch/search.service';
import { UserVectorService } from '../../../infrastructure/postgres/user-vector.service';
import { QueueService } from '../../../infrastructure/queue/queue.service';
import { JOB_SEND_NOTIFICATION } from '../../../infrastructure/queue/queue.constants';
import { TemporalService } from '../../../infrastructure/temporal/temporal.service';
import { ONBOARDING_WORKFLOW } from '../../../infrastructure/temporal/temporal.constants';

const ES_INDEX = 'users';
/**
 * Fallback for the onboarding follow-up delay. Short so the demo is
 * observable; in production this would be hours or days. The live value must
 * come from ConfigService: reading process.env at import time bypasses the Joi
 * schema, so neither its default nor its validation would apply.
 */
const DEFAULT_ONBOARDING_FOLLOWUP_DELAY_MS = 30_000;
const cacheKey = (id: string) => `user:${id}`;
/** Dedup marker so a redelivered event (Pulsar `shared` sub, relay lock expiry)
 *  isn't processed twice — the whole handler is idempotent per eventId. */
const dedupKey = (eventId: string) => `user-processor:seen:${eventId}`;
const DEDUP_TTL_SECONDS = 24 * 60 * 60;
/**
 * Short-lived claim, held only while the handler runs. Released on failure so a
 * redelivery can retry; promoted to DEDUP_TTL_SECONDS once the work succeeds.
 *
 * Must stay below the broker's ackTimeoutMs (60s, pulsar-broker.adapter.ts): a
 * pod killed mid-handler cannot release the claim, so the redelivery that
 * arrives at the ack timeout must be able to re-claim it. A claim that outlives
 * the timeout makes that redelivery look like a duplicate, and the event is
 * dropped.
 */
const DEDUP_IN_PROGRESS_SECONDS = 30;

/** Shape of the outbox payload (relay publishes it under `payload`). */
interface UserEventPayload {
  userId: string;
  name?: string;
  email?: string;
  age?: number;
  loginCount?: number;
}

/**
 * The single durable consumer of user events: outbox → Pulsar → here.
 *
 * Owns ALL at-least-once side-effects — the counter/cache AND the Elasticsearch
 * index, the pgvector upsert, and the welcome email. They belong here rather
 * than on an in-process EventEmitter, where a crash after the DB commit loses
 * them: that is a dual-write, and the outbox path is durable and retryable.
 * Ephemeral realtime WebSocket broadcasts stay in-process (see
 * UserEventHandlers) — losing one is fine.
 */
@Injectable()
export class UserProcessor implements OnModuleInit, OnModuleDestroy {
  private subscription: MessageSubscription | null = null;
  private readonly onboardingFollowupDelayMs: number;

  constructor(
    @InjectPinoLogger(UserProcessor.name) private readonly logger: PinoLogger,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBrokerPort,
    private readonly searchService: SearchService,
    private readonly vectorService: UserVectorService,
    private readonly queueService: QueueService,
    private readonly temporal: TemporalService,
    config: ConfigService,
  ) {
    this.onboardingFollowupDelayMs = config.get<number>(
      'ONBOARDING_FOLLOWUP_DELAY_MS',
      DEFAULT_ONBOARDING_FOLLOWUP_DELAY_MS,
    );
  }

  async onModuleInit() {
    try {
      this.subscription = await this.broker.subscribe(
        USER_TOPIC,
        USER_PULSAR_SUBSCRIPTION,
        (data) =>
          this.handle(JSON.parse(data.toString()) as Record<string, unknown>),
        { type: 'shared' },
      );
      this.logger.info('UserProcessor started');
    } catch {
      this.logger.warn('UserProcessor: broker not available, skipping');
    }
  }

  async onModuleDestroy() {
    await this.subscription?.close();
  }

  private async handle(msg: Record<string, unknown>) {
    const eventType = msg.eventType as string | undefined;
    const eventId = msg.eventId as string | undefined;
    // The business fields live in the outbox `payload` (the relay wraps them),
    // never at the top level; `aggregateId` is the fallback for the id.
    const payload = (msg.payload ?? {}) as UserEventPayload;
    const userId = payload.userId ?? (msg.aggregateId as string | undefined);
    if (typeof userId !== 'string') return;

    // Idempotency, claim-then-commit: take a SHORT-lived claim (atomic SET NX)
    // before doing the work, and only extend it to the full dedup window once
    // the work succeeded. Claiming the full 24h up front would leave a marker
    // behind when a handler fails half-way, so Pulsar's redelivery would hit
    // the dedup check, return early, and drop the event permanently.
    const claimKey = typeof eventId === 'string' ? dedupKey(eventId) : null;
    if (claimKey) {
      const claimed = await this.redis.set(
        claimKey,
        '1',
        'EX',
        DEDUP_IN_PROGRESS_SECONDS,
        'NX',
      );
      if (claimed !== 'OK') {
        this.logger.debug(
          { eventId },
          'UserProcessor: duplicate event skipped',
        );
        return;
      }
    }

    try {
      switch (eventType) {
        case USER_EVENTS.CREATED:
          await this.onCreated(userId, payload);
          break;
        case USER_EVENTS.UPDATED:
          await this.onUpdated(userId, payload);
          break;
        case USER_EVENTS.DELETED:
          await this.onDeleted(userId);
          break;
        default:
          this.logger.warn({ eventType }, 'UserProcessor: unknown event type');
      }
      // Commit the dedup marker for the full window.
      if (claimKey) await this.redis.expire(claimKey, DEDUP_TTL_SECONDS);
    } catch (err) {
      // Release the claim so the redelivery is allowed to retry, then rethrow
      // so the broker nacks instead of acknowledging a half-applied event.
      if (claimKey) {
        await this.redis
          .del(claimKey)
          .catch((e: Error) =>
            this.logger.error(
              `Failed to release dedup claim ${claimKey}: ${e.message}`,
            ),
          );
      }
      this.logger.error(
        { eventId, userId, eventType },
        `UserProcessor: handler failed, will retry — ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * Runs every sink, then fails if ANY of them failed.
   *
   * Throwing is what makes Pulsar redeliver. A per-promise `.catch(log)` would
   * let `allSettled` always resolve, so the message is ACKed with a sink such
   * as Elasticsearch never applied — the user is missing from search with no
   * retry and no signal.
   *
   * Note the pgvector sinks swallow their own errors internally and always
   * resolve, so in practice only Elasticsearch and the queue can fail a group.
   * Every sink must therefore be idempotent: a single failure replays them all.
   */
  private async runSinks(
    label: string,
    tasks: { name: string; run: Promise<unknown> }[],
  ): Promise<void> {
    const results = await Promise.allSettled(tasks.map((t) => t.run));
    const failed = results
      .map((r, i) => ({ r, name: tasks[i].name }))
      .filter((x) => x.r.status === 'rejected')
      .map(
        (x) =>
          `${x.name}: ${((x.r as PromiseRejectedResult).reason as Error)?.message ?? 'unknown'}`,
      );
    if (failed.length) {
      throw new Error(`${label} — ${failed.join('; ')}`);
    }
  }

  private async onCreated(userId: string, p: UserEventPayload) {
    await this.runSinks('user created', [
      {
        name: 'elasticsearch',
        run: this.searchService.index(ES_INDEX, {
          id: userId,
          name: p.name ?? '',
          email: p.email ?? '',
          status: UserStatus.ACTIVE,
          age: p.age ?? 0,
        }),
      },
      {
        name: 'pgvector',
        run: this.vectorService.upsertVector(userId, {
          name: p.name ?? '',
          email: p.email ?? '',
          age: p.age ?? 0,
          status: UserStatus.ACTIVE,
          loginCount: p.loginCount ?? 0,
        }),
      },
      {
        name: 'welcome-email',
        run: this.queueService.enqueueNotification(
          JOB_SEND_NOTIFICATION,
          {
            userId,
            channel: 'email',
            template: 'welcome',
            payload: {
              to: p.email ?? '',
              name: p.name ?? '',
              subject: 'Welcome!',
              html: `<p>Hi ${p.name ?? 'there'}, welcome to the platform.</p>`,
            },
          },
          // Deterministic jobId so a redelivery (any other sink in this group
          // failing forces one) cannot enqueue a second welcome email: BullMQ
          // drops an add() whose jobId already exists.
          // NOTE: BullMQ rejects ':' in a custom id (it is its key separator),
          // so the separator here must stay '-'.
          { jobId: `welcome-${userId}` },
        ),
      },
    ]);
    this.logger.info(
      { userId },
      'UserProcessor: user created — index + welcome',
    );

    // Kick off the durable onboarding follow-up. Fire-and-forget and tolerant of
    // Temporal being down — signup must never fail because of it.
    if (this.temporal.available) {
      this.temporal
        .startWorkflow(
          ONBOARDING_WORKFLOW,
          [
            {
              userId,
              email: p.email ?? '',
              name: p.name ?? 'there',
              delayMs: this.onboardingFollowupDelayMs,
            },
          ],
          { workflowId: `onboarding-${userId}` },
        )
        .catch((e) =>
          this.logger.warn(
            `Onboarding workflow start failed: ${(e as Error).message}`,
          ),
        );
    }
  }

  private async onUpdated(userId: string, p: UserEventPayload) {
    await this.redis.del(cacheKey(userId));
    await this.runSinks('user updated', [
      {
        name: 'elasticsearch',
        run: this.searchService.index(ES_INDEX, {
          id: userId,
          name: p.name ?? '',
          email: p.email ?? '',
          status: UserStatus.ACTIVE,
          age: p.age ?? 0,
        }),
      },
      {
        name: 'pgvector',
        run: this.vectorService.upsertVector(userId, {
          name: p.name ?? '',
          email: p.email ?? '',
          age: p.age ?? 0,
          status: UserStatus.ACTIVE,
          loginCount: p.loginCount ?? 0,
        }),
      },
    ]);
    this.logger.info(
      { userId },
      'UserProcessor: user updated — cache + re-index',
    );
  }

  private async onDeleted(userId: string) {
    await this.redis.del(cacheKey(userId));
    await this.runSinks('user deleted', [
      {
        name: 'elasticsearch',
        run: this.searchService.delete(ES_INDEX, userId),
      },
      { name: 'pgvector', run: this.vectorService.deleteVector(userId) },
    ]);
    this.logger.info({ userId }, 'UserProcessor: user deleted — purge');
  }
}
