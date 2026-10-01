export const AUDIT_LOG_TABLE = 'logs.audit_log';

export const AUDIT_OUTCOME = {
  SUCCESS: 'success',
  ERROR: 'error',
} as const;

export type AuditOutcome = (typeof AUDIT_OUTCOME)[keyof typeof AUDIT_OUTCOME];

/** tenant_id of an audit row for an action that resolved no tenant. */
export const PLATFORM_SCOPE_TENANT = '';
