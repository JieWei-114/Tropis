import { randomUUID } from 'crypto';
import { USER_EVENTS } from '../constants/user.constants';

export class UserCreatedEvent {
  static readonly EVENT = USER_EVENTS.CREATED;
  readonly eventId = randomUUID();
  constructor(
    public readonly userId: string,
    public readonly name: string,
    public readonly email: string,
  ) {}
}

export class UserUpdatedEvent {
  static readonly EVENT = USER_EVENTS.UPDATED;
  readonly eventId = randomUUID();
  constructor(
    public readonly userId: string,
    public readonly name: string,
    public readonly email: string,
    public readonly age?: number,
    public readonly loginCount?: number,
  ) {}
}

// UserDeletedEvent removed: user deletion has no in-process (WebSocket) side
// effect; its durable side-effects (cache/counter/ES/vector purge) run in the
// Pulsar consumer (UserProcessor) off the outbox — not the EventEmitter.
