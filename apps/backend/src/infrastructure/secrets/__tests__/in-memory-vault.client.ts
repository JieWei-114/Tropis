import { randomUUID } from 'crypto';
import type { VaultFactory } from '../adapters/vault/vault-secrets.adapter';

type VaultClient = ReturnType<VaultFactory>;

function notFound(path: string): Error {
  return Object.assign(new Error(`Status 404: ${path}`), {
    response: { statusCode: 404 },
  });
}

/**
 * A Vault factory over an in-memory KV v2 store and Transit engine, enough
 * of node-vault for the SecretsPort conformance suite. Ciphertexts carry a
 * random nonce, so equal plaintexts encrypt differently, and only ones it
 * issued decrypt. No database engine is mounted.
 */
export function inMemoryVault(options: {
  kv: Record<string, Record<string, string>>;
  transitKeys: string[];
}): VaultFactory {
  const issued = new Map<string, string>();
  const client: VaultClient = {
    health: () => Promise.resolve({ initialized: true, sealed: false }),
    read: (path) => {
      const data = options.kv[path];
      return data
        ? Promise.resolve({ data: { data } })
        : Promise.reject(notFound(path));
    },
    write: (path, body) => {
      const [engine, op, key] = path.split('/');
      if (engine !== 'transit' || !options.transitKeys.includes(key)) {
        return Promise.reject(notFound(path));
      }
      if (op === 'encrypt') {
        const ciphertext = `vault:v1:${Buffer.from(randomUUID()).toString('base64')}`;
        issued.set(ciphertext, String(body.plaintext));
        return Promise.resolve({ data: { ciphertext } });
      }
      const plaintext = issued.get(String(body.ciphertext));
      return plaintext === undefined
        ? Promise.reject(new Error('Status 400: invalid ciphertext'))
        : Promise.resolve({ data: { plaintext } });
    },
    token: {
      renewSelf: () => Promise.resolve({ auth: { lease_duration: 3600 } }),
    },
  };
  return () => client;
}
