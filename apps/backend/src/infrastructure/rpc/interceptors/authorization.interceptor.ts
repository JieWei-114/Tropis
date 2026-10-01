import type { DescMethod } from '@bufbuild/protobuf';
import type { Interceptor } from '@connectrpc/connect';
import type { AuthorizationService } from '../../../common/authz/authorization.service';
import type { Permission } from '../../../common/authz/authorize.decorator';
import { callerOf, RPC_CREDENTIALS } from '../rpc-authz.service';

/**
 * Enforces @Authorize on RPC handlers: a method whose handler carries a
 * permission runs only for a verified caller whose roles the policy allows.
 * Innermost in the chain, so a denial is audited like any other failure.
 */
export function authorizationInterceptor(
  authorization: AuthorizationService,
  permissionOf: (method: DescMethod) => Permission | undefined,
): Interceptor {
  return (next) => async (req) => {
    const permission = permissionOf(req.method);
    if (permission) {
      const caller = callerOf(req.contextValues.get(RPC_CREDENTIALS));
      await authorization.assert(caller.roles, permission);
    }
    return next(req);
  };
}
