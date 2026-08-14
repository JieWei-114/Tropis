export const AUDIT_LOG_TABLE = 'logs.audit_log';

export const AUDIT_OUTCOME = {
  SUCCESS: 'success',
  ERROR: 'error',
} as const;

export type AuditOutcome = (typeof AUDIT_OUTCOME)[keyof typeof AUDIT_OUTCOME];
