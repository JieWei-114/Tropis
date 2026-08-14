/**
 * VaultModule — wraps HashiCorp Vault KV v2 secret loading.
 *
 * @Global() so VaultService can be injected anywhere without re-importing.
 *
 * Behaviour:
 *   - VAULT_ADDR + VAULT_TOKEN set → fetches secrets from Vault on startup,
 *     merges them into process.env BEFORE NestJS ConfigModule reads them.
 *   - Not set → silently skips, app falls back to .env values as normal.
 *
 * This means Vault is opt-in: the app works with just .env for quick local runs,
 * and automatically picks up Vault when the env vars are present.
 */

import { Global, Module } from '@nestjs/common';
import { VaultService } from './vault.service';

@Global()
@Module({
  providers: [VaultService],
  exports: [VaultService],
})
export class VaultModule {}
