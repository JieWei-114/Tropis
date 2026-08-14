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
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { MESSAGE_BROKER } from '../../../infrastructure/messaging/message-broker.port';
import type {
  MessageBrokerPort,
  MessageSubscription,
} from '../../../infrastructure/messaging/message-broker.port';

const TOTAL_KEY = 'users:total';
const cacheKey = (id: string) => `user:${id}`;

@Injectable()
export class UserProcessor implements OnModuleInit, OnModuleDestroy {
  private subscription: MessageSubscription | null = null;

  constructor(
    @InjectPinoLogger(UserProcessor.name) private readonly logger: PinoLogger,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBrokerPort,
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
    const { eventType, userId } = msg;
    if (typeof userId !== 'string') return;

    switch (eventType) {
      case USER_EVENTS.CREATED:
        // Increment global user counter in Redis
        await this.redis.incr(TOTAL_KEY);
        this.logger.info(
          { userId },
          'UserProcessor: user created — counter incremented',
        );
        break;

      case USER_EVENTS.UPDATED:
        // Bust the per-user Redis cache so next read fetches fresh from MongoDB
        await this.redis.del(cacheKey(userId));
        this.logger.info(
          { userId },
          'UserProcessor: user updated — cache busted',
        );
        break;

      case USER_EVENTS.DELETED:
        // Remove from cache and decrement counter
        await Promise.all([
          this.redis.del(cacheKey(userId)),
          this.redis.decr(TOTAL_KEY),
        ]);
        this.logger.info(
          { userId },
          'UserProcessor: user deleted — cache busted, counter decremented',
        );
        break;

      default:
        this.logger.warn({ eventType }, 'UserProcessor: unknown event type');
    }
  }
}
