import { capabilityUp, type CapabilityHealth } from '../../../capability';
import type { DatabaseCredentials, SecretsPort } from '../../secrets.port';

/**
 * Secrets from the process environment. There is no key store, so encrypt
 * and decrypt resolve null (callers redact), and dynamic credentials are
 * never issued.
 */
export class EnvSecretsAdapter implements SecretsPort {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  getSecret(_path: string, key: string): Promise<string | null> {
    const value = this.env[key];
    return Promise.resolve(value === undefined || value === '' ? null : value);
  }

  encrypt(): Promise<string | null> {
    return Promise.resolve(null);
  }

  decrypt(): Promise<string | null> {
    return Promise.resolve(null);
  }

  getDynamicDbCredentials(): Promise<DatabaseCredentials | null> {
    return Promise.resolve(null);
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('env'));
  }
}
