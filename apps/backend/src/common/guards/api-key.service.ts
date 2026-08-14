import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Resolves API-key secrets for HMAC request signing (docs/api-conventions.md).
 *
 * Template storage: the `API_KEYS` env var holds a JSON map
 * `{ "<keyId>": "<secret>", ... }`. Because VaultService merges the
 * `secret/data/tropis` KV path into process.env at bootstrap, putting
 * API_KEYS in Vault "just works" without any code change.
 *
 * Production note: prefer one Vault KV entry per key
 * (e.g. secret/data/api-keys/<keyId>) read at runtime via
 * VaultService.getSecret(), so keys can be rotated/revoked individually
 * without redeploying. The env-map approach here is the template default
 * because it works with plain .env for local runs.
 */
@Injectable()
export class ApiKeyService {
  private cache: Record<string, string> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Returns the shared secret for a key id, or null if the key is unknown. */
  getSecret(keyId: string): string | null {
    if (this.cache === null) {
      try {
        const parsed: unknown = JSON.parse(
          this.config.get<string>('API_KEYS', '{}'),
        );
        this.cache =
          parsed !== null && typeof parsed === 'object'
            ? (parsed as Record<string, string>)
            : {};
      } catch {
        this.cache = {};
      }
    }
    const secret = this.cache[keyId];
    return typeof secret === 'string' && secret.length > 0 ? secret : null;
  }
}
