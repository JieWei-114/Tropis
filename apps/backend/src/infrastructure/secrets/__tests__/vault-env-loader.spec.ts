import {
  loadVaultSecretsIntoEnv,
  type VaultClientFactory,
} from '../adapters/vault/vault-env-loader';

function fakeVault(secrets: Record<string, unknown>) {
  const calls: { endpoint: string; token?: string }[] = [];
  const reads: string[] = [];
  const factory: VaultClientFactory = (options) => {
    calls.push(options);
    return {
      read: (path: string) => {
        reads.push(path);
        return Promise.resolve({ data: { data: secrets } });
      },
      write: () => Promise.resolve({ auth: { client_token: 'app-token' } }),
    };
  };
  return { factory, calls, reads };
}

describe('loadVaultSecretsIntoEnv', () => {
  it('supplies keys the environment does not set, and never overrides it', async () => {
    const env: NodeJS.ProcessEnv = {
      VAULT_ADDR: 'http://vault:8200',
      VAULT_TOKEN: 'root',
      API_KEYS: '{"from":"env"}',
      EMPTY: '',
    };
    const vault = fakeVault({
      JWT_SECRET: 'from-vault',
      API_KEYS: '{"from":"vault"}',
      EMPTY: 'filled',
    });

    await expect(loadVaultSecretsIntoEnv(env, vault.factory)).resolves.toBe(2);

    expect(env.JWT_SECRET).toBe('from-vault');
    expect(env.API_KEYS).toBe('{"from":"env"}');
    expect(env.EMPTY).toBe('filled');
    expect(vault.reads).toEqual(['secret/data/tropis']);
  });

  it('logs in with AppRole when a role id and secret id are set', async () => {
    const env: NodeJS.ProcessEnv = {
      VAULT_ADDR: 'http://vault:8200',
      VAULT_ROLE_ID: 'r',
      VAULT_SECRET_ID: 's',
      VAULT_SECRET_PATH: 'secret/data/other',
    };
    const vault = fakeVault({ JWT_SECRET: 'x' });

    await loadVaultSecretsIntoEnv(env, vault.factory);

    expect(vault.calls.at(-1)).toEqual({
      endpoint: 'http://vault:8200',
      token: 'app-token',
    });
    expect(vault.reads).toEqual(['secret/data/other']);
  });

  it('does nothing without VAULT_ADDR or with SECRETS_ADAPTER=env', async () => {
    const vault = fakeVault({ JWT_SECRET: 'x' });
    await expect(loadVaultSecretsIntoEnv({}, vault.factory)).resolves.toBe(0);
    await expect(
      loadVaultSecretsIntoEnv(
        { SECRETS_ADAPTER: 'env', VAULT_ADDR: 'http://v', VAULT_TOKEN: 't' },
        vault.factory,
      ),
    ).resolves.toBe(0);
    expect(vault.calls).toEqual([]);
  });

  it('falls back to the environment when Vault is unreachable', async () => {
    const env: NodeJS.ProcessEnv = { VAULT_ADDR: 'http://v', VAULT_TOKEN: 't' };
    const factory: VaultClientFactory = () => ({
      read: () => Promise.reject(new Error('ECONNREFUSED')),
      write: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(loadVaultSecretsIntoEnv(env, factory)).resolves.toBe(0);
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('refuses to boot in production when Vault is configured but unreachable', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      VAULT_ADDR: 'http://v',
      VAULT_TOKEN: 't',
    };
    const factory: VaultClientFactory = () => ({
      read: () => Promise.reject(new Error('ECONNREFUSED')),
      write: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(loadVaultSecretsIntoEnv(env, factory)).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('refuses to boot in production when Vault has no credentials', async () => {
    const vault = fakeVault({});
    await expect(
      loadVaultSecretsIntoEnv(
        { NODE_ENV: 'production', VAULT_ADDR: 'http://v' },
        vault.factory,
      ),
    ).rejects.toThrow('no Vault credentials');
  });
});
