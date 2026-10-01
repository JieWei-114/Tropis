import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isTenantId, type TenantId } from '../keyspace';

/** One API key: its signing secret and the tenant it acts for. */
export interface ApiKey {
  secret: string;
  tenantId: TenantId;
}

/** Parses API_KEYS; entries without a secret or a valid tenant are dropped. */
export function parseApiKeys(raw: string): Record<string, ApiKey> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const keys: Record<string, ApiKey> = {};
  for (const [id, entry] of Object.entries(parsed)) {
    const { secret, tenantId } = (entry ?? {}) as Record<string, unknown>;
    if (typeof secret === 'string' && secret && isTenantId(tenantId)) {
      keys[id] = { secret, tenantId };
    }
  }
  return keys;
}

/**
 * Resolves API keys for HMAC request signing (docs/api-conventions.md).
 *
 * `API_KEYS` holds a JSON map `{ "<keyId>": { "secret": "...", "tenantId":
 * "..." } }`: each key is bound to one tenant, and a signed request acts for
 * that tenant only. The map comes from the environment or Vault (merged
 * before config validation), is read on first use and then cached, so
 * rotating or revoking a key needs a restart.
 */
@Injectable()
export class ApiKeyService {
  private cache: Record<string, ApiKey> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** The key, or null if the key id is unknown. */
  getKey(keyId: string): ApiKey | null {
    this.cache ??= parseApiKeys(this.config.getOrThrow<string>('API_KEYS'));
    return Object.prototype.hasOwnProperty.call(this.cache, keyId)
      ? this.cache[keyId]
      : null;
  }
}
