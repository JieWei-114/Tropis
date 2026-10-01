import { ConfigService } from '@nestjs/config';
import { UserInternalRpcController } from '../controllers/user-internal.rpc.controller';
import { UserService } from '../services/user.service';
import { rpcContextFor } from '../../../infrastructure/rpc/testing/rpc-test-context';
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
  let serviceToken: string;
  let controller: UserInternalRpcController;

  beforeEach(() => {
    serviceToken = 'svc-token';
    userService = {
      findByEmailWithPassword: jest.fn().mockResolvedValue(user),
    };
    const config = {
      getOrThrow: (key: string) =>
        key === 'SERVICE_TOKEN' ? serviceToken : 'jwt-secret',
    } as unknown as ConfigService;
    controller = new UserInternalRpcController(
      userService as unknown as UserService,
      config,
      new TenantContext(),
    );
  });

  const call = (headers: Record<string, string>, email = 'a@example.com') =>
    runInTenant(toTenantId('acme'), () =>
      controller.getUserByEmail({ email } as never, rpcContextFor({}, headers)),
    );

  it('returns the user without sensitive fields for a valid service token', async () => {
    const res = await call({ 'x-service-token': 'svc-token' });
    expect(res).toEqual({
      id: 'u1',
      name: 'Alice',
      email: 'a@example.com',
      age: 0,
      status: 'active',
      loginCount: 4,
    });
  });

  it('is disabled when SERVICE_TOKEN is unset', async () => {
    serviceToken = '';
    await expect(call({ 'x-service-token': '' })).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });

  it.each<Record<string, string>>([
    {},
    { 'x-service-token': 'wrong' },
    { 'x-service-token': 'svc' },
  ])('rejects a missing or wrong service token (%p)', async (headers) => {
    await expect(call(headers)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(userService.findByEmailWithPassword).not.toHaveBeenCalled();
  });

  it('validates the email and reports unknown users', async () => {
    await expect(
      call({ 'x-service-token': 'svc-token' }, ''),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    userService.findByEmailWithPassword.mockResolvedValue(null);
    await expect(
      call({ 'x-service-token': 'svc-token' }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});
