import { AppError } from '../errors/app-error';
import type { TenantId } from '../keyspace';
import { parseTenantId } from './tenant.context';

/**
 * The tenant of one request, from what the transport verified:
 *
 *   1. A verified access token's tenant is authoritative.
 *   2. A tenant hint (X-Tenant-ID, or `?tenant=` where a header cannot be
 *      set) is accepted only without a verified token; with one it must
 *      name the token's tenant, else TENANT_MISMATCH.
 *   3. Neither: undefined. The request runs unscoped and any tenant-scoped
 *      read fails with TENANT_REQUIRED; there is no fallback tenant.
 *
 * A malformed hint is rejected with TENANT_INVALID.
 */
export function resolveTenant(
  verifiedTenant: TenantId | undefined,
  hint: unknown,
): TenantId | undefined {
  const requested =
    typeof hint === 'string' && hint.length > 0
      ? parseTenantId(hint)
      : undefined;
  if (verifiedTenant) {
    if (requested && requested !== verifiedTenant) {
      throw new AppError('TENANT_MISMATCH');
    }
    return verifiedTenant;
  }
  return requested;
}
