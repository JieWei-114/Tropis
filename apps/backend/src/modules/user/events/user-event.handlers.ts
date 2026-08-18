import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { UserCreatedEvent, UserUpdatedEvent } from './user.events';
import { NotificationGateway } from '../../websocket/gateways/notification.gateway';
import { USER_EVENTS } from '../constants/user.constants';

/**
 * In-process handlers for the EPHEMERAL side of user events: real-time
 * WebSocket notifications only.
 *
 * The DURABLE side-effects (Elasticsearch index, pgvector upsert, welcome email)
 * were moved OUT of here to the Pulsar consumer (`UserProcessor`) so they survive
 * a crash after the DB commit — see that file. WebSocket pushes are inherently
 * ephemeral (a dropped realtime ping is not a consistency bug), so they stay
 * in-process where they fire instantly instead of after outbox-relay lag.
 */
@Injectable()
export class UserEventHandlers {
  private readonly logger = new Logger(UserEventHandlers.name);

  constructor(private readonly notificationGateway: NotificationGateway) {}

  @OnEvent(UserCreatedEvent.EVENT)
  onUserCreated(event: UserCreatedEvent) {
    this.notificationGateway.broadcast(USER_EVENTS.CREATED, {
      userId: event.userId,
      email: event.email,
    });
  }

  @OnEvent(UserUpdatedEvent.EVENT)
  onUserUpdated(event: UserUpdatedEvent) {
    this.notificationGateway.sendToUser(event.userId, USER_EVENTS.UPDATED, {
      userId: event.userId,
    });
  }
}
