import { UserInternalRpcController } from '../controllers/user-internal.rpc.controller';
import { UserService } from '../services/user.service';
import {
  TenantContext,
  runInTenant,
} from '../../../common/tenant/tenant.context';
import { toTenantId } from '../../../common/keyspace';

describe('UserInternalRpcController', () => {
  const user = {
    id: 'u1',
    name: 'Alice',
    email: 'a@example.com',
    status: 'active',
    loginCount: 4,
    passwordHash: 'secret-hash',
  };
  let userService: { findByEmailWithPassword: jest.Mock };
  let controller: UserInternalRpcController;

  beforeEach(() => {
    userService = {
      findByEmailWithPassword: jest.fn().mockResolvedValue(user),
    };
    controller = new UserInternalRpcController(
      userService as unknown as UserService,
      new TenantContext(),
    );
  });

  const call = (email = 'a@example.com') =>
    runInTenant(toTenantId('acme'), () =>
      controller.getUserByEmail({ email } as never),
    );

  it('returns the user without sensitive fields', async () => {
    const res = await call();
    expect(res).toEqual({
      id: 'u1',
      name: 'Alice',
      email: 'a@example.com',
      age: 0,
      status: 'active',
      loginCount: 4,
    });
  });

  it('validates the email and reports unknown users', async () => {
    await expect(call('')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    userService.findByEmailWithPassword.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});
