import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { VaultService } from '../vault/vault.service';
import { UserVectorService } from './user-vector.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService, VaultService],
      useFactory: async (config: ConfigService, vault: VaultService) => {
        // Prefer Vault-issued dynamic credentials; fall back to static .env values.
        // Dynamic creds have a TTL managed by Vault; TypeORM reconnects on its own.
        const dynamic = await vault.getDynamicDbCredentials().catch(() => null);

        return {
          type: 'postgres',
          host: config.get('POSTGRES_HOST', 'localhost'),
          port: config.get<number>('POSTGRES_PORT', 5432),
          username: dynamic?.username ?? config.get('POSTGRES_USER', 'tropis'),
          password:
            dynamic?.password ??
            config.get('POSTGRES_PASSWORD', 'tropis_dev_password'),
          database: config.get('POSTGRES_DB', 'tropis'),
          autoLoadEntities: true,
          // Survive a slow-starting Postgres (k8s cold start, compose race)
          // without crash-looping the whole app: retry for ~90s, then keep the
          // pool alive across transient drops instead of tearing down.
          retryAttempts: config.get<number>('POSTGRES_RETRY_ATTEMPTS', 30),
          retryDelay: config.get<number>('POSTGRES_RETRY_DELAY', 3000),
          keepConnectionAlive: true,
          // synchronize MUST stay false in all environments — use TypeORM migrations.
          // NODE_ENV=production check is insufficient because a misconfigured staging env
          // could silently drop columns. Explicit opt-in via TYPEORM_SYNC=true for local dev only.
          synchronize: config.get('TYPEORM_SYNC') === 'true',
          ssl:
            config.get('POSTGRES_SSL') === 'true'
              ? { rejectUnauthorized: false }
              : false,
          // pg pool — explicit caps for production (TypeORM passes `extra` to node-postgres Pool)
          extra: {
            max: 20,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
          },
        };
      },
    }),
  ],
  providers: [UserVectorService],
  exports: [TypeOrmModule, UserVectorService],
})
export class PostgresModule {}
