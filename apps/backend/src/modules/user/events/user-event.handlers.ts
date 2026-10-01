import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { UserCreatedEvent, UserUpdatedEvent } from './user.events';
import {
  REALTIME,
  type RealtimePort,
} from '../../../infrastructure/realtime/realtime.port';
import { USER_EVENTS } from '../constants/user.constants';
import { UserRole } from '../constants/user.enums';

/**
 * In-process realtime pushes for user events. Losing one is harmless, so
 * they stay off the outbox; the durable side effects run in UserProcessor.
 * A new member's details go to the tenant's admins only (the Users page);
 * an update goes to that user's own sockets.
 */
@Injectable()
export class UserEventHandlers {
  constructor(@Inject(REALTIME) private readonly realtime: RealtimePort) {}

  @OnEvent(UserCreatedEvent.EVENT)
  async onUserCreated(event: UserCreatedEvent) {
    await this.realtime.publishToRoles(
      event.tenantId,
      [UserRole.ADMIN],
      USER_EVENTS.CREATED,
      { userId: event.userId, name: event.name },
    );
  }

  @OnEvent(UserUpdatedEvent.EVENT)
  async onUserUpdated(event: UserUpdatedEvent) {
    await this.realtime.publishToUser(
      event.tenantId,
      event.userId,
      USER_EVENTS.UPDATED,
      { userId: event.userId },
    );
  }
}
