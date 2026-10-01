import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { selectAdapter } from '../capability';
import { EnvSecretsAdapter } from './adapters/env/env-secrets.adapter';
import { VaultSecretsAdapter } from './adapters/vault/vault-secrets.adapter';
import { SecretsHealthIndicator } from './secrets.health';
import { SECRETS, SECRETS_ADAPTERS, type SecretsPort } from './secrets.port';

/**
 * Provides SECRETS (SecretsPort), adapter chosen by SECRETS_ADAPTER.
 *
 * `vault` (default) is opt-in at runtime: with VAULT_ADDR unset it logs and
 * behaves like `env` for encryption (resolves null). The KV secrets reach
 * process.env through secretsLoaded() (secrets-env.ts), which the config
 * module awaits before it validates the environment.
 */
@Module({})
export class SecretsModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (SecretsModule.root ??= {
      module: SecretsModule,
      providers: [
        {
          provide: SECRETS,
          inject: [ConfigService],
          useFactory: (config: ConfigService): SecretsPort => {
            const adapter = selectAdapter(
              'SECRETS_ADAPTER',
              config.get<string>('SECRETS_ADAPTER'),
              SECRETS_ADAPTERS,
              'vault',
            );
            return adapter === 'env'
              ? new EnvSecretsAdapter()
              : new VaultSecretsAdapter(config);
          },
        },
        SecretsHealthIndicator,
      ],
      exports: [SECRETS, SecretsHealthIndicator],
    });
  }
}
