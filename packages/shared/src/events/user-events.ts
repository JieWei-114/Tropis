/**
 * The user events contract: the topic the user module publishes to through
 * the outbox, and the `data` of each type. Consumers outside the user module
 * depend on this file only, so the publisher can change everything else.
 * Evolution is add-only: consumers tolerate unknown fields.
 */
export const USER_EVENTS_TOPIC = 'user-events';

export interface UserCreatedData {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  /** The member who invited this user, when the sign-up came from an invitation. */
  invitedBy?: string;
}

export interface UserUpdatedData {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  age?: number;
  loginCount: number;
  /** The user's roles after the change. */
  roles?: string[];
  /** The user's status after the change. */
  status?: string;
}

export interface UserDeletedData {
  userId: string;
  tenantId: string;
  email: string;
}

export type UserEventData = UserCreatedData | UserUpdatedData | UserDeletedData;
