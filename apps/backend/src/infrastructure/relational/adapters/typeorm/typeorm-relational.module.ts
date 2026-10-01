import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { SecretsModule } from '../../../secrets/secrets.module';
import { SECRETS, type SecretsPort } from '../../../secrets/secrets.port';
import { RELATIONAL } from '../../relational.port';
import { TypeOrmRelationalAdapter } from './typeorm-relational.adapter';

/**
 * TLS for the pool: off unless POSTGRES_SSL=true, and then the server
 * certificate is always verified, against POSTGRES_SSL_CA (PEM) when set or
 * the system roots otherwise.
 */
export function postgresTls(
  config: ConfigService,
): false | { rejectUnauthorized: true; ca?: string } {
  if (config.getOrThrow<string>('POSTGRES_SSL') !== 'true') return false;
  const ca = config.get<string>('POSTGRES_SSL_CA');
  return ca
    ? { rejectUnauthorized: true, ca: ca.replace(/\\n/g, '\n') }
    : { rejectUnauthorized: true };
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [SecretsModule.forRoot()],
      inject: [ConfigService, SECRETS],
      useFactory: async (config: ConfigService, secrets: SecretsPort) => {
        // Prefer dynamically issued credentials; fall back to static .env values.
        // Dynamic creds have a TTL managed by the secrets store; TypeORM reconnects on its own.
        const dynamic = await secrets
          .getDynamicDbCredentials()
          .catch(() => null);

        return {
          type: 'postgres',
          host: config.getOrThrow<string>('POSTGRES_HOST'),
          port: config.getOrThrow<number>('POSTGRES_PORT'),
          username:
            dynamic?.username ?? config.getOrThrow<string>('POSTGRES_USER'),
          password:
            dynamic?.password ?? config.getOrThrow<string>('POSTGRES_PASSWORD'),
          database: config.getOrThrow<string>('POSTGRES_DB'),
          autoLoadEntities: true,
          // Survive a slow-starting Postgres (k8s cold start, compose race)
          // without crash-looping the whole app: retry for ~90s, then keep the
          // pool alive across transient drops instead of tearing down.
          retryAttempts: config.getOrThrow<number>('POSTGRES_RETRY_ATTEMPTS'),
          retryDelay: config.getOrThrow<number>('POSTGRES_RETRY_DELAY'),
          keepConnectionAlive: true,
          // synchronize MUST stay false in all environments — use migrations.
          // NODE_ENV=production check is insufficient because a misconfigured staging env
          // could silently drop columns. Explicit opt-in via TYPEORM_SYNC=true for local dev only.
          synchronize: config.getOrThrow<boolean>('TYPEORM_SYNC') === true,
          ssl: postgresTls(config),
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
  providers: [
    {
      provide: RELATIONAL,
      inject: [getDataSourceToken()],
      useFactory: (dataSource: DataSource) =>
        new TypeOrmRelationalAdapter(dataSource),
    },
  ],
  exports: [RELATIONAL],
})
export class TypeOrmRelationalModule {}
