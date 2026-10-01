import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { UserEventData } from '@tropis/shared';
import {
  EventConsumer,
  type ConsumerHandle,
} from '../../../infrastructure/messaging/event-consumer';
import {
  USER_EVENT_SEEN,
  USER_SUBSCRIPTION,
  USER_TOPIC,
} from '../constants/user.constants';
import { UserProjectionService } from '../services/user-projection.service';

/**
 * The durable consumer of user events (outbox → broker → here), on a
 * key_shared subscription keyed by user id, once per envelope id. The side
 * effects are UserProjectionService's; ephemeral realtime pushes stay
 * in-process (UserEventHandlers).
 */
@Injectable()
export class UserProcessor implements OnModuleInit, OnModuleDestroy {
  private subscription: ConsumerHandle | null = null;

  constructor(
    private readonly consumer: EventConsumer,
    private readonly projection: UserProjectionService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.consumer.start<Partial<UserEventData>>({
      topic: USER_TOPIC,
      subscription: USER_SUBSCRIPTION,
      type: 'key_shared',
      module: 'user',
      handle: async ({ data, envelope, tenantId }) => {
        const userId = data.userId ?? envelope.subject;
        if (typeof userId !== 'string') return;
        await this.consumer.once(USER_EVENT_SEEN.global(envelope.id), () =>
          this.projection.apply(envelope.type, tenantId, userId),
        );
      },
    });
  }

  async onModuleDestroy() {
    await this.subscription?.close();
  }
}
