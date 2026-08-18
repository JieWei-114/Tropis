import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
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

const ES_INDEX = 'users';
const TOTAL_KEY = 'users:total';
const cacheKey = (id: string) => `user:${id}`;
/** Dedup marker so a redelivered event (Pulsar `shared` sub, relay lock expiry)
 *  isn't processed twice — the whole handler is idempotent per eventId. */
const dedupKey = (eventId: string) => `user-processor:seen:${eventId}`;
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

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
 * index, the pgvector upsert, and the welcome email. These used to run in-process
 * off an EventEmitter (lost on a crash after the DB commit — a dual-write). Routing
 * them through the outbox makes them durable and retryable. Ephemeral realtime
 * WebSocket broadcasts stay in-process (see UserEventHandlers) — losing one is fine.
 */
@Injectable()
export class UserProcessor implements OnModuleInit, OnModuleDestroy {
  private subscription: MessageSubscription | null = null;

  constructor(
    @InjectPinoLogger(UserProcessor.name) private readonly logger: PinoLogger,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBrokerPort,
    private readonly searchService: SearchService,
    private readonly vectorService: UserVectorService,
    private readonly queueService: QueueService,
  ) {}

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
    // The business fields live in the outbox `payload` (the relay wraps them);
    // fall back to `aggregateId` for the id. (The previous `msg.userId` read was
    // always undefined — the counter never actually incremented.)
    const payload = (msg.payload ?? {}) as UserEventPayload;
    const userId = payload.userId ?? (msg.aggregateId as string | undefined);
    if (typeof userId !== 'string') return;

    // Idempotency: claim the eventId once (atomic SET NX). A redelivery is a
    // no-op, so the counter isn't double-counted and side-effects don't repeat.
    if (typeof eventId === 'string') {
      const claimed = await this.redis.set(
        dedupKey(eventId),
        '1',
        'EX',
        DEDUP_TTL_SECONDS,
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
  }

  private async onCreated(userId: string, p: UserEventPayload) {
    await this.redis.incr(TOTAL_KEY);
    await Promise.allSettled([
      this.searchService
        .index(ES_INDEX, {
          id: userId,
          name: p.name ?? '',
          email: p.email ?? '',
          status: UserStatus.ACTIVE,
          age: p.age ?? 0,
        })
        .catch((e) =>
          this.logger.warn(`ES index failed: ${(e as Error).message}`),
        ),
      this.vectorService
        .upsertVector(userId, {
          name: p.name ?? '',
          email: p.email ?? '',
          age: p.age ?? 0,
          status: UserStatus.ACTIVE,
          loginCount: p.loginCount ?? 0,
        })
        .catch((e) =>
          this.logger.warn(`Vector upsert failed: ${(e as Error).message}`),
        ),
      this.queueService
        .enqueueNotification(JOB_SEND_NOTIFICATION, {
          userId,
          channel: 'email',
          template: 'welcome',
          payload: {
            to: p.email ?? '',
            name: p.name ?? '',
            subject: 'Welcome!',
            html: `<p>Hi ${p.name ?? 'there'}, welcome to the platform.</p>`,
          },
        })
        .catch((e) =>
          this.logger.warn(`Queue enqueue failed: ${(e as Error).message}`),
        ),
    ]);
    this.logger.info(
      { userId },
      'UserProcessor: user created — counter + index + welcome',
    );
  }

  private async onUpdated(userId: string, p: UserEventPayload) {
    await this.redis.del(cacheKey(userId));
    await Promise.allSettled([
      this.searchService
        .index(ES_INDEX, {
          id: userId,
          name: p.name ?? '',
          email: p.email ?? '',
          status: UserStatus.ACTIVE,
          age: p.age ?? 0,
        })
        .catch((e) =>
          this.logger.warn(`ES index failed: ${(e as Error).message}`),
        ),
      this.vectorService
        .upsertVector(userId, {
          name: p.name ?? '',
          email: p.email ?? '',
          age: p.age ?? 0,
          status: UserStatus.ACTIVE,
          loginCount: p.loginCount ?? 0,
        })
        .catch((e) =>
          this.logger.warn(`Vector upsert failed: ${(e as Error).message}`),
        ),
    ]);
    this.logger.info(
      { userId },
      'UserProcessor: user updated — cache + re-index',
    );
  }

  private async onDeleted(userId: string) {
    await Promise.all([
      this.redis.del(cacheKey(userId)),
      this.redis.decr(TOTAL_KEY),
    ]);
    await Promise.allSettled([
      this.searchService
        .delete(ES_INDEX, userId)
        .catch((e) =>
          this.logger.warn(`ES delete failed: ${(e as Error).message}`),
        ),
      this.vectorService
        .deleteVector(userId)
        .catch((e) =>
          this.logger.warn(`Vector delete failed: ${(e as Error).message}`),
        ),
    ]);
    this.logger.info(
      { userId },
      'UserProcessor: user deleted — counter + purge',
    );
  }
}
