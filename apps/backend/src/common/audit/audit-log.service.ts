import { Injectable, Inject } from '@nestjs/common';
import { createLogger } from '../observability/logger';
import { OLAP, type OlapPort } from '../../infrastructure/olap/olap.port';
import { AUDIT_LOG_TABLE, PLATFORM_SCOPE_TENANT } from './audit.constants';
import { IAuditEntry } from './audit.interface';

/**
 * Fire-and-forget audit writer. Entries with a tenant go through the
 * tenant-scoped insert; an entry without one (an unauthenticated request
 * that named no tenant) is a platform-scope row with tenant_id ''.
 * Called by the AuditInterceptor — never
 * awaited on the request path, and never throws: a broken OLAP store must
 * not take down mutating endpoints (log-and-continue, like analytics).
 */
@Injectable()
export class AuditLogService {
  private readonly logger = createLogger('audit');

  constructor(@Inject(OLAP) private readonly olap: OlapPort) {}

  /** Queue an audit entry for insertion. Returns immediately. */
  record(entry: IAuditEntry): void {
    const row = {
      timestamp: entry.timestamp.getTime(),
      action: entry.action,
      actor_user_id: entry.actorUserId,
      resource: entry.resource,
      transport: entry.transport,
      outcome: entry.outcome,
      error: entry.error ?? '',
      trace_id: entry.traceId,
    };
    const write = entry.tenantId
      ? this.olap.insert(entry.tenantId, AUDIT_LOG_TABLE, [row])
      : this.olap.insertGlobal(AUDIT_LOG_TABLE, [
          { ...row, tenant_id: PLATFORM_SCOPE_TENANT },
        ]);
    void write.catch((err: unknown) => {
      this.logger.warn(
        'insert-failed',
        'Audit entry insert failed',
        { 'audit.action': entry.action },
        err,
      );
    });
  }
}
