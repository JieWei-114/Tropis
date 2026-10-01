import { toTenantId } from '../../../common/keyspace';
import type { RealtimePort } from '../../../infrastructure/realtime/realtime.port';
import { UserEventHandlers } from '../events/user-event.handlers';
import { UserCreatedEvent } from '../events/user.events';

describe('UserEventHandlers', () => {
  const tenant = toTenantId('acme');

  // Reproduces the leak: user.created carried the new member's email to
  // every socket of the tenant, including self-registered members.
  it('pushes a new member to the tenant admins only, without the email', async () => {
    const realtime = {
      publishToRoles: jest.fn().mockResolvedValue(undefined),
      publishToTenant: jest.fn().mockResolvedValue(undefined),
    };
    const handlers = new UserEventHandlers(realtime as unknown as RealtimePort);

    await handlers.onUserCreated(
      new UserCreatedEvent(tenant, 'u1', 'Alice', 'alice@example.com'),
    );

    expect(realtime.publishToTenant).not.toHaveBeenCalled();
    expect(realtime.publishToRoles).toHaveBeenCalledWith(
      tenant,
      ['admin'],
      'user.created',
      { userId: 'u1', name: 'Alice' },
    );
  });
});
