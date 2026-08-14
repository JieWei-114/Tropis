import { Injectable, Inject, Logger } from '@nestjs/common';
import type { ClickHouseClient } from '@clickhouse/client';
import { CLICKHOUSE_CLIENT } from '../../../infrastructure/clickhouse/clickhouse.module';
import { AUDIT_LOG_TABLE } from '../constants';
import { IAuditEntry } from '../interfaces';

/**
 * Fire-and-forget audit writer. Called by the AuditInterceptor — never
 * awaited on the request path, and never throws: a broken ClickHouse must
 * not take down mutating endpoints (log-and-continue, like analytics).
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @Inject(CLICKHOUSE_CLIENT) private readonly ch: ClickHouseClient,
  ) {}

  /** Queue an audit entry for insertion. Returns immediately. */
  record(entry: IAuditEntry): void {
    void this.ch
      .insert({
        table: AUDIT_LOG_TABLE,
        values: [
          {
            timestamp: entry.timestamp.getTime(),
            action: entry.action,
            actor_user_id: entry.actorUserId,
            tenant_id: entry.tenantId,
            resource: entry.resource,
            transport: entry.transport,
            outcome: entry.outcome,
            error: entry.error ?? '',
            trace_id: entry.traceId,
          },
        ],
        format: 'JSONEachRow',
      })
      .catch((err: unknown) => {
        this.logger.warn({ err, action: entry.action }, 'audit insert failed');
      });
  }
}
