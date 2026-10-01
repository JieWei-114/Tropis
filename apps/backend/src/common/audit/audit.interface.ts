import type { TenantId } from '../keyspace';
import { AuditOutcome } from './audit.constants';

/** One security-relevant event, as written to ClickHouse logs.audit_log. */
export interface IAuditEntry {
  action: string;
  actorUserId: string;
  /** Absent for a platform-scope action (no tenant resolved). */
  tenantId?: TenantId;
  resource: string;
  transport: 'http' | 'rpc' | 'ws';
  outcome: AuditOutcome;
  error?: string;
  traceId: string;
  timestamp: Date;
}
