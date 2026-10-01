import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { selectAdapter } from '../capability';
import { importWhenSelected } from '../capability/conditional-import';
import {
  REDIS_CLIENT,
  RedisConnectionModule,
} from '../connections/redis/redis-connection.module';
import { DisabledLockAdapter } from './adapters/disabled/disabled-lock.adapter';
import { RedisLockAdapter } from './adapters/redis/redis-lock.adapter';
import { LockHealthIndicator } from './lock.health';
import { LOCK, LOCK_ADAPTERS, type LockPort } from './lock.port';

/** Provides LOCK (LockPort), adapter chosen by LOCK_ADAPTER. */
@Module({})
export class LockModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (LockModule.root ??= {
      module: LockModule,
      imports: [
        importWhenSelected(
          'LOCK_ADAPTER',
          'redis',
          'redis',
          RedisConnectionModule,
        ),
      ],
      providers: [
        {
          provide: LOCK,
          inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
          useFactory: (config: ConfigService, redis?: Redis): LockPort => {
            const adapter = selectAdapter(
              'LOCK_ADAPTER',
              config.get<string>('LOCK_ADAPTER'),
              LOCK_ADAPTERS,
              'redis',
            );
            if (adapter === 'disabled') return new DisabledLockAdapter();
            if (!redis)
              throw new Error('LOCK_ADAPTER=redis requires RedisModule');
            return new RedisLockAdapter(redis);
          },
        },
        LockHealthIndicator,
      ],
      exports: [LOCK, LockHealthIndicator],
    });
  }
}
