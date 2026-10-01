import type { HealthCheckable } from '../capability';

/**
 * Secrets — runtime secret reads, envelope encryption and dynamic database
 * credentials. Every method resolves null when the backing store cannot
 * answer, so callers decide how to degrade: an `encrypt` that returns null
 * means "do not store the plaintext" (callers redact).
 */
export const SECRETS = Symbol('SECRETS');

export interface DatabaseCredentials {
  username: string;
  password: string;
}

export interface SecretsPort extends HealthCheckable {
  /** One value from a secret path, or null. */
  getSecret(path: string, key: string): Promise<string | null>;
  /** Ciphertext for `plaintext` under the named key, or null when encryption is unavailable. */
  encrypt(keyName: string, plaintext: string): Promise<string | null>;
  /** Plaintext for a ciphertext produced by encrypt(), or null. */
  decrypt(keyName: string, ciphertext: string): Promise<string | null>;
  /** Short-lived database credentials for `role`, or null to use static ones. */
  getDynamicDbCredentials(role?: string): Promise<DatabaseCredentials | null>;
}

export const SECRETS_ADAPTERS = ['vault', 'env'] as const;
export type SecretsAdapterName = (typeof SECRETS_ADAPTERS)[number];
