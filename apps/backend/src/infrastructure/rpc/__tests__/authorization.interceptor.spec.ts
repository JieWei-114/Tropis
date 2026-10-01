import { Code, ConnectError, createContextValues } from '@connectrpc/connect';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import type { Permission } from '../../../common/authz/authorize.decorator';
import { toTenantId } from '../../../common/keyspace';
import { HealthService } from '../../../gen/health/v1/health_pb';
import type { PolicyPort } from '../../policy/policy.port';
import { authorizationInterceptor } from '../interceptors/authorization.interceptor';
import { errorsInterceptor } from '../interceptors/errors.interceptor';
import { RPC_CREDENTIALS, type RpcCredentials } from '../rpc-authz.service';

const principal = {
  userId: 'u1',
  email: 'a@example.com',
  roles: ['viewer'],
  tenantId: toTenantId('acme'),
  jti: 'j',
  exp: 0,
};

describe('authorizationInterceptor', () => {
  const run = async (
    permission: Permission | undefined,
    credentials: RpcCredentials,
    allow = true,
  ) => {
    const policy = { allow: jest.fn().mockResolvedValue(allow) };
    const next = jest.fn().mockResolvedValue({ ok: true });
    const values = createContextValues();
    values.set(RPC_CREDENTIALS, credentials);
    const call = errorsInterceptor(
      authorizationInterceptor(
        new AuthorizationService(policy as unknown as PolicyPort),
        () => permission,
      )(next as never),
    );
    const result = await (call as (req: unknown) => Promise<unknown>)({
      method: HealthService.method.check,
      contextValues: values,
    }).catch((e: unknown) => e);
    return { result, policy, next };
  };

  it('passes a method without @Authorize straight through', async () => {
    const { result, policy, next } = await run(undefined, {});
    expect(result).toEqual({ ok: true });
    expect(policy.allow).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('rejects an unauthenticated call to a protected method', async () => {
    const { result, next } = await run(
      { resource: 'user', action: 'read' },
      {},
    );
    expect((result as ConnectError).code).toBe(Code.Unauthenticated);
    expect(next).not.toHaveBeenCalled();
  });

  it('asks the policy with the caller roles and denies', async () => {
    const { result, policy, next } = await run(
      { resource: 'user', action: 'delete' },
      { token: 't', principal },
      false,
    );
    expect(policy.allow).toHaveBeenCalledWith({
      roles: ['viewer'],
      resource: 'user',
      action: 'delete',
    });
    expect((result as ConnectError).code).toBe(Code.PermissionDenied);
    expect(next).not.toHaveBeenCalled();
  });

  it('runs the handler when the policy allows', async () => {
    const { result, next } = await run(
      { resource: 'user', action: 'read' },
      { token: 't', principal },
    );
    expect(result).toEqual({ ok: true });
    expect(next).toHaveBeenCalled();
  });
});
