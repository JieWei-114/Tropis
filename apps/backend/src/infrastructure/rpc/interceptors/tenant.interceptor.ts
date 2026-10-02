import type { Interceptor } from '@connectrpc/connect';
import type { TenantId } from '../../../common/keyspace';
import { resolveTenant } from '../../../common/tenant/tenant-resolution';
import { runInTenant } from '../../../common/tenant/tenant.context';
import { RPC_CREDENTIALS } from '../rpc-authz.service';
import { toConnectError } from '../rpc-errors';
import { setSpanTenant } from '../../../common/observability/propagation';
import { setRequestTenant } from '../../../common/observability/request-context';

/**
 * Binds the call's tenant (common/tenant/tenant-resolution.ts): the verified
 * token's tenant, else the X-Tenant-ID header of a call without a valid
 * token. A header that contradicts the token is rejected; a call with
 * neither runs unscoped, and any tenant-scoped read in it fails with
 * TENANT_REQUIRED.
 */
export function tenantInterceptor(): Interceptor {
  return (next) => (req) => {
    const { principal } = req.contextValues.get(RPC_CREDENTIALS);
    let tenantId: TenantId | undefined;
    try {
      tenantId = resolveTenant(
        principal?.tenantId,
        req.header.get('x-tenant-id'),
      );
    } catch (err) {
      throw toConnectError(err);
    }
    if (!tenantId) return next(req);
    setRequestTenant(tenantId);
    setSpanTenant(tenantId);
    return runInTenant(tenantId, () => next(req));
  };
}
