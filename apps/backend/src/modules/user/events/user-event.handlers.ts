import { Injectable, Logger, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type Redis from 'ioredis';
import {
  UserCreatedEvent,
  UserUpdatedEvent,
  UserDeletedEvent,
} from './user.events';
import { SearchService } from '../../../infrastructure/elasticsearch/search.service';
import { UserVectorService } from '../../../infrastructure/postgres/user-vector.service';
import { NotificationGateway } from '../../websocket/gateways/notification.gateway';
import { QueueService } from '../../../infrastructure/queue/queue.service';
import { JOB_SEND_NOTIFICATION } from '../../../infrastructure/queue/queue.constants';
import { UserStatus } from '../schemas/user.schema';
import { USER_EVENTS } from '../constants/user.constants';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';

const ES_INDEX = 'users';
// Event side-effects are deduplicated for 24 h — if the same event fires twice
// (e.g. during replay or after a crash-restart), the handler is a no-op after the first run.
const REPLAY_TTL_S = 86_400;

@Injectable()
export class UserEventHandlers {
  private readonly logger = new Logger(UserEventHandlers.name);

  constructor(
    private readonly searchService: SearchService,
    private readonly vectorService: UserVectorService,
    private readonly notificationGateway: NotificationGateway,
    private readonly queueService: QueueService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Returns true if this handler invocation is a duplicate and should be skipped. */
  private async isDuplicate(key: string): Promise<boolean> {
    // NX: only set if key does not already exist — atomic check-and-set
    const result = await this.redis
      .set(key, '1', 'EX', REPLAY_TTL_S, 'NX')
      .catch(() => null);
    return result === null; // null means key already existed → duplicate
  }

  @OnEvent(UserCreatedEvent.EVENT)
  async onUserCreated(event: UserCreatedEvent) {
    if (
      await this.isDuplicate(`event:${USER_EVENTS.CREATED}:${event.eventId}`)
    ) {
      this.logger.warn(
        `Skipping duplicate ${USER_EVENTS.CREATED} for ${event.userId}`,
      );
      return;
    }

    await Promise.allSettled([
      this.searchService
        .index(ES_INDEX, {
          id: event.userId,
          name: event.name,
          email: event.email,
          status: UserStatus.ACTIVE,
          age: 0,
        })
        .catch((e) => this.logger.warn(`ES index failed: ${e.message}`)),

      this.vectorService
        .upsertVector(event.userId, {
          name: event.name,
          email: event.email,
          age: 0,
          status: UserStatus.ACTIVE,
          loginCount: 0,
        })
        .catch((e) => this.logger.warn(`Vector upsert failed: ${e.message}`)),

      this.queueService
        .enqueueNotification(JOB_SEND_NOTIFICATION, {
          userId: event.userId,
          channel: 'email',
          template: 'welcome',
          payload: {
            to: event.email,
            name: event.name,
            subject: 'Welcome!',
            html: `<p>Hi ${event.name}, welcome to the platform.</p>`,
          },
        })
        .catch((e) => this.logger.warn(`Queue enqueue failed: ${e.message}`)),
    ]);

    this.notificationGateway.broadcast(USER_EVENTS.CREATED, {
      userId: event.userId,
      email: event.email,
    });
  }

  @OnEvent(UserUpdatedEvent.EVENT)
  async onUserUpdated(event: UserUpdatedEvent) {
    if (await this.isDuplicate(`event:${USER_EVENTS.UPDATED}:${event.eventId}`))
      return;

    await Promise.allSettled([
      this.searchService
        .index(ES_INDEX, {
          id: event.userId,
          name: event.name,
          email: event.email,
          status: UserStatus.ACTIVE,
          age: event.age ?? 0,
        })
        .catch((e) => this.logger.warn(`ES index failed: ${e.message}`)),

      this.vectorService
        .upsertVector(event.userId, {
          name: event.name,
          email: event.email,
          age: event.age ?? 0,
          status: UserStatus.ACTIVE,
          loginCount: event.loginCount ?? 0,
        })
        .catch((e) => this.logger.warn(`Vector upsert failed: ${e.message}`)),
    ]);

    this.notificationGateway.sendToUser(event.userId, USER_EVENTS.UPDATED, {
      userId: event.userId,
    });
  }

  @OnEvent(UserDeletedEvent.EVENT)
  async onUserDeleted(event: UserDeletedEvent) {
    if (await this.isDuplicate(`event:${USER_EVENTS.DELETED}:${event.eventId}`))
      return;

    await Promise.allSettled([
      this.searchService
        .delete(ES_INDEX, event.userId)
        .catch((e) => this.logger.warn(`ES delete failed: ${e.message}`)),

      this.vectorService
        .deleteVector(event.userId)
        .catch((e) => this.logger.warn(`Vector delete failed: ${e.message}`)),
    ]);
  }
}
