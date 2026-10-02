import type { TenantId } from '../keyspace';

export const CREDENTIAL_ATTEMPTS = Symbol('CREDENTIAL_ATTEMPTS');

/**
 * The login lockout, for any password check outside login (the current
 * password on a self email or password change), so a guesser holding a
 * session cannot try passwords without counting toward the lockout.
 * Implemented by the auth module (LoginLockoutService).
 */
export interface CredentialAttempts {
  /** Throws AUTH_LOGIN_LOCKED while the email (or email + ip) is locked. */
  assertAllowed(tenantId: TenantId, email: string, ip: string): Promise<void>;
  /** Counts one wrong password toward the lockout. */
  recordFailure(tenantId: TenantId, email: string, ip: string): Promise<void>;
}
