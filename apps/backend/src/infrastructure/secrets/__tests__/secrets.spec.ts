import type { ConfigService } from '@nestjs/config';
import { EnvSecretsAdapter } from '../adapters/env/env-secrets.adapter';
import { VaultSecretsAdapter } from '../adapters/vault/vault-secrets.adapter';
import type { SecretsPort } from '../secrets.port';

const config = (values: Record<string, string>) =>
  ({
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  }) as unknown as ConfigService;

describe('EnvSecretsAdapter', () => {
  const adapter: SecretsPort = new EnvSecretsAdapter({
    API_KEYS: '{"k":"s"}',
    EMPTY: '',
  });

  it('reads secrets from the environment by key', async () => {
    await expect(adapter.getSecret('any/path', 'API_KEYS')).resolves.toBe(
      '{"k":"s"}',
    );
    await expect(adapter.getSecret('any/path', 'EMPTY')).resolves.toBeNull();
    await expect(adapter.getSecret('any/path', 'MISSING')).resolves.toBeNull();
  });

  it('cannot encrypt, so callers redact', async () => {
    await expect(adapter.encrypt('user-data', 'a@b.c')).resolves.toBeNull();
    await expect(
      adapter.decrypt('user-data', 'vault:v1:x'),
    ).resolves.toBeNull();
  });

  it('never issues dynamic credentials', async () => {
    await expect(adapter.getDynamicDbCredentials()).resolves.toBeNull();
  });

  it('reports up', async () => {
    await expect(adapter.health()).resolves.toEqual({
      status: 'up',
      adapter: 'env',
    });
  });
});

describe('VaultSecretsAdapter', () => {
  it('stays unconnected and reports disabled when VAULT_ADDR is unset', async () => {
    const adapter = new VaultSecretsAdapter(config({}));
    await adapter.onModuleInit();

    expect(adapter.isConnected).toBe(false);
    await expect(adapter.encrypt('user-data', 'a@b.c')).resolves.toBeNull();
    await expect(adapter.health()).resolves.toMatchObject({
      status: 'disabled',
    });
  });

  it('reports down, not disabled, when Vault is configured but unreachable', async () => {
    const adapter = new VaultSecretsAdapter(
      config({ VAULT_ADDR: 'http://127.0.0.1:1', VAULT_TOKEN: 'token' }),
    );
    await adapter.onModuleInit();

    expect(adapter.isConnected).toBe(false);
    await expect(adapter.health()).resolves.toMatchObject({
      status: 'down',
      adapter: 'vault',
    });
    await adapter.onModuleDestroy();
  });

  it('sets a request timeout on every client it creates', async () => {
    const created: Record<string, unknown>[] = [];
    jest.isolateModules(() => {
      jest.doMock('node-vault', () => (options: Record<string, unknown>) => {
        created.push(options);
        return {
          health: () => Promise.resolve({}),
          token: { renewSelf: () => Promise.resolve({}) },
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../adapters/vault/vault-secrets.adapter') as {
        VaultSecretsAdapter: typeof VaultSecretsAdapter;
      };
      const adapter = new mod.VaultSecretsAdapter(
        config({ VAULT_ADDR: 'http://v', VAULT_TOKEN: 't' }),
      );
      void adapter.onModuleInit().then(() => adapter.onModuleDestroy());
    });
    await new Promise((r) => setImmediate(r));
    expect(created[0]).toMatchObject({
      requestOptions: { timeout: expect.any(Number) },
    });
  });

  it('logs in again with AppRole when the token can no longer be renewed', async () => {
    jest.useFakeTimers();
    let logins = 0;
    const factory = jest.fn((options: { token?: string }) => ({
      health: () => Promise.resolve({}),
      read: () => Promise.resolve({}),
      write: () => {
        logins += 1;
        return Promise.resolve({
          auth: { client_token: `token-${logins}`, lease_duration: 90 },
        });
      },
      token: {
        renewSelf: () =>
          options.token === 'token-1'
            ? Promise.reject(new Error('token past max TTL'))
            : Promise.resolve({ auth: { lease_duration: 90 } }),
      },
    }));
    const adapter = new VaultSecretsAdapter(
      config({
        VAULT_ADDR: 'http://v',
        VAULT_ROLE_ID: 'r',
        VAULT_SECRET_ID: 's',
      }),
      factory as never,
    );
    await adapter.onModuleInit();
    expect(logins).toBe(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(logins).toBe(2);
    expect(adapter.isConnected).toBe(true);
    await adapter.onModuleDestroy();
    jest.useRealTimers();
  });
});
