import type { ConfigService } from '@nestjs/config';
import { VaultSecretsAdapter } from '../../src/infrastructure/secrets/adapters/vault/vault-secrets.adapter';
import { describeSecretsPort } from '../../src/infrastructure/secrets/__tests__/secrets.conformance';
import { describeWithDocker } from './docker';
import {
  freePort,
  readyOrStop,
  startContainer,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

const ROOT_TOKEN = 'conformance-root';
const TRANSIT_KEY = 'conformance-data';
const SEEDED = { path: 'secret/data/tropis', key: 'API_KEY', value: 'k-1' };

const config = (values: Record<string, string>) =>
  ({
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  }) as unknown as ConfigService;

async function vault(
  url: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${url}/v1/${path}`, {
    method: 'POST',
    headers: {
      'X-Vault-Token': ROOT_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new Error(`Vault ${path} failed: ${res.status} ${await res.text()}`);
  }
}

async function connected(
  values: Record<string, string>,
): Promise<VaultSecretsAdapter> {
  const adapter = new VaultSecretsAdapter(config(values));
  await adapter.onModuleInit();
  return adapter;
}

describeWithDocker('Secrets conformance (vault)')(
  'Secrets conformance (vault)',
  () => {
    let container: StartedContainer;
    let url: string;

    beforeAll(async () => {
      container = startContainer({
        image: 'hashicorp/vault:1.17',
        label: 'vault',
        ports: [8200],
        env: {
          VAULT_DEV_ROOT_TOKEN_ID: ROOT_TOKEN,
          VAULT_DEV_LISTEN_ADDRESS: '0.0.0.0:8200',
          SKIP_SETCAP: 'true',
        },
        command: ['server', '-dev'],
      });
      url = `http://${container.host}:${container.port(8200)}`;
      await readyOrStop(container, async () => {
        await waitUntil(
          'vault',
          async () => (await fetch(`${url}/v1/sys/health`)).ok,
          60_000,
          container,
        );
        await vault(url, 'sys/mounts/transit', { type: 'transit' });
        await vault(url, `transit/keys/${TRANSIT_KEY}`);
        await vault(url, SEEDED.path, {
          data: { [SEEDED.key]: SEEDED.value },
        });
      });
    });

    afterAll(async () => {
      await container?.stop();
    });

    describeSecretsPort('vault', {
      live: {
        seeded: SEEDED,
        encryptionKey: TRANSIT_KEY,
        make: () => connected({ VAULT_ADDR: url, VAULT_TOKEN: ROOT_TOKEN }),
        teardown: (port) => (port as VaultSecretsAdapter).onModuleDestroy(),
      },
      unreachable: {
        make: async () =>
          connected({
            VAULT_ADDR: `http://127.0.0.1:${await freePort()}`,
            VAULT_TOKEN: ROOT_TOKEN,
          }),
        teardown: (port) => (port as VaultSecretsAdapter).onModuleDestroy(),
      },
    });
  },
);
