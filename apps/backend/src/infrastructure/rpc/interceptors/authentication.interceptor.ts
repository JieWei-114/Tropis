import type { Interceptor } from '@connectrpc/connect';
import { RPC_CREDENTIALS, type RpcAuthzService } from '../rpc-authz.service';

/**
 * Verifies the bearer token once per call and stores the outcome in the
 * handler context. It never rejects: public methods (Login, Create, health)
 * take no token, and protected handlers reject through RpcAuthzService.
 */
export function authenticationInterceptor(authz: RpcAuthzService): Interceptor {
  return (next) => async (req) => {
    req.contextValues.set(
      RPC_CREDENTIALS,
      await authz.authenticate(req.header),
    );
    return next(req);
  };
}
