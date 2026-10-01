import { loadVaultSecretsIntoEnv } from './adapters/vault/vault-env-loader';

let loaded: Promise<void> | null = null;

/**
 * Resolves once the Vault KV secrets are merged into process.env (or
 * immediately when Vault is not configured). Started by the validated
 * config module before it validates the environment; anything that reads
 * configuration while modules are composed awaits it, so a value Vault
 * supplies is seen there too.
 */
export function secretsLoaded(): Promise<void> {
  loaded ??= loadVaultSecretsIntoEnv(process.env).then(() => undefined);
  return loaded;
}
