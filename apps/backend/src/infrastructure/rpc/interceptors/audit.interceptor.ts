import type { DescMethod } from '@bufbuild/protobuf';
import type { Interceptor } from '@connectrpc/connect';
import { getRequestId } from '../../../common/middleware/correlation-id.middleware';
import type { AuditLogService } from '../../../common/audit/audit-log.service';
import { AUDIT_OUTCOME } from '../../../common/audit/audit.constants';
import type { IAuditEntry } from '../../../common/audit/audit.interface';
import { currentTenant } from '../../../common/tenant/tenant.context';
import { RPC_CREDENTIALS } from '../rpc-authz.service';
import { errorMessage } from '../rpc-errors';

/** What the audit trail needs to know about the handler behind a method. */
export interface RpcAuditTarget {
  /** Action name from @Audited on the handler (or its class). */
  action?: string;
  /** `<ImplementingClass>.<method>`. */
  resource: string;
}

/**
 * Writes an audit entry for every call whose handler is marked
 * @Audited('action'), with outcome success or error. The actor and tenant
 * come from the verified token only: an unverifiable token yields an empty
 * actor rather than letting a forged `sub` be attributed. Recording is
 * fire-and-forget inside AuditLogService, so audit failures never affect the
 * call.
 */
export function auditInterceptor(
  auditLog: AuditLogService,
  targetOf: (method: DescMethod) => RpcAuditTarget | undefined,
): Interceptor {
  return (next) => async (req) => {
    const target = targetOf(req.method);
    if (!target?.action) return next(req);

    const { principal } = req.contextValues.get(RPC_CREDENTIALS);
    const base: Omit<IAuditEntry, 'outcome' | 'timestamp' | 'error'> = {
      action: target.action,
      actorUserId: principal?.userId ?? '',
      tenantId: principal?.tenantId ?? currentTenant(),
      resource: target.resource,
      transport: 'rpc',
      traceId: getRequestId(),
    };

    try {
      const res = await next(req);
      auditLog.record({
        ...base,
        outcome: AUDIT_OUTCOME.SUCCESS,
        timestamp: new Date(),
      });
      return res;
    } catch (err) {
      auditLog.record({
        ...base,
        outcome: AUDIT_OUTCOME.ERROR,
        error: errorMessage(err),
        timestamp: new Date(),
      });
      throw err;
    }
  };
}
