import { randomUUID } from 'crypto';
import type { TenantId } from '../../../common/keyspace';
import { USER_EVENTS } from '../constants/user.constants';

export class UserCreatedEvent {
  static readonly EVENT = USER_EVENTS.CREATED;
  readonly eventId = randomUUID();
  constructor(
    public readonly tenantId: TenantId,
    public readonly userId: string,
    public readonly name: string,
    public readonly email: string,
  ) {}
}

export class UserUpdatedEvent {
  static readonly EVENT = USER_EVENTS.UPDATED;
  readonly eventId = randomUUID();
  constructor(
    public readonly tenantId: TenantId,
    public readonly userId: string,
    public readonly name: string,
    public readonly email: string,
    public readonly age?: number,
    public readonly loginCount?: number,
  ) {}
}
