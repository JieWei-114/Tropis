import { createLogger } from '../../../../common/observability/logger';

/** The part of a Vault client the loader uses. */
export interface VaultKvClient {
  read(path: string): Promise<{ data?: { data?: Record<string, unknown> } }>;
  write(
    path: string,
    data: Record<string, unknown>,
  ): Promise<{ auth?: { client_token?: string } }>;
}

export type VaultClientFactory = (options: {
  endpoint: string;
  token?: string;
}) => VaultKvClient;

/** Every Vault HTTP request fails after this, instead of hanging boot. */
export const VAULT_REQUEST_TIMEOUT_MS = 5_000;

const defaultFactory: VaultClientFactory = (options) =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node-vault') as (o: Record<string, unknown>) => VaultKvClient)({
    ...options,
    requestOptions: { timeout: VAULT_REQUEST_TIMEOUT_MS },
  });

const logger = createLogger('secrets');

const unset = (value: string | undefined) =>
  value === undefined || value === '';

async function login(
  env: NodeJS.ProcessEnv,
  addr: string,
  factory: VaultClientFactory,
): Promise<VaultKvClient | null> {
  const { VAULT_TOKEN, VAULT_ROLE_ID, VAULT_SECRET_ID } = env;
  if (VAULT_ROLE_ID && VAULT_SECRET_ID) {
    const res = await factory({ endpoint: addr }).write('auth/approle/login', {
      role_id: VAULT_ROLE_ID,
      secret_id: VAULT_SECRET_ID,
    });
    const token = res.auth?.client_token;
    if (!token) throw new Error('AppRole login returned no token');
    return factory({ endpoint: addr, token });
  }
  if (VAULT_TOKEN) return factory({ endpoint: addr, token: VAULT_TOKEN });
  return null;
}

/**
 * Copies the Vault KV secrets at VAULT_SECRET_PATH into `env` for every key
 * the environment does not already set. Runs before the config schema is
 * validated, so Vault can supply any declared key (JWT_SECRET, API_KEYS,
 * datastore credentials); the environment still overrides Vault, and Vault
 * overrides the schema defaults. Does nothing unless SECRETS_ADAPTER is
 * `vault` (the default) and VAULT_ADDR is set. Outside production an
 * unreachable Vault (or missing credentials) is logged and the environment
 * applies as it is; in production it rejects, so the process fails to boot
 * instead of running on the schema's development defaults.
 *
 * Returns how many keys were injected.
 */
export async function loadVaultSecretsIntoEnv(
  env: NodeJS.ProcessEnv = process.env,
  factory: VaultClientFactory = defaultFactory,
): Promise<number> {
  if ((env.SECRETS_ADAPTER || 'vault') !== 'vault') return 0;
  const addr = env.VAULT_ADDR;
  if (!addr) return 0;
  const path = env.VAULT_SECRET_PATH || 'secret/data/tropis';
  const production = env.NODE_ENV === 'production';
  try {
    const client = await login(env, addr, factory);
    if (!client) {
      if (production) {
        throw new Error(
          'VAULT_ADDR is set but no Vault credentials are (VAULT_TOKEN or VAULT_ROLE_ID + VAULT_SECRET_ID)',
        );
      }
      logger.warn(
        'vault-no-credentials',
        'No Vault credentials (VAULT_TOKEN or VAULT_ROLE_ID + VAULT_SECRET_ID); secrets come from the environment',
      );
      return 0;
    }
    const secrets = (await client.read(path))?.data?.data ?? {};
    let injected = 0;
    for (const [key, value] of Object.entries(secrets)) {
      if (unset(env[key]) && value !== undefined && value !== null) {
        env[key] = typeof value === 'string' ? value : JSON.stringify(value);
        injected++;
      }
    }
    logger.info('secrets-loaded', 'Secrets loaded from Vault', {
      'vault.path': path,
      'vault.secrets_injected': injected,
    });
    return injected;
  } catch (err) {
    if (production) {
      logger.error(
        'vault-unavailable',
        'Vault is configured but unavailable; refusing to start in production',
        err,
        { 'vault.path': path },
      );
      throw err;
    }
    logger.warn(
      'vault-unavailable',
      'Vault is unavailable; secrets come from the environment',
      { 'vault.path': path },
      err,
    );
    return 0;
  }
}
