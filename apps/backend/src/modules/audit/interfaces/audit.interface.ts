import { AuditOutcome } from '../constants';

/** One security-relevant event, as written to ClickHouse logs.audit_log. */
export interface IAuditEntry {
  action: string;
  actorUserId: string;
  tenantId: string;
  resource: string;
  transport: 'http' | 'rpc' | 'ws';
  outcome: AuditOutcome;
  error?: string;
  traceId: string;
  timestamp: Date;
}
