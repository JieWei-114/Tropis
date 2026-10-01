import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { selectAdapter } from '../capability';
import { importWhenSelected } from '../capability/conditional-import';
import {
  REDIS_CLIENT,
  RedisConnectionModule,
} from '../connections/redis/redis-connection.module';
import { DisabledCacheAdapter } from './adapters/disabled/disabled-cache.adapter';
import { RedisCacheStore } from './adapters/redis/redis-cache.store';
import { CacheClient } from './cache.client';
import { CacheHealthIndicator } from './cache.health';
import { CACHE, CACHE_ADAPTERS, type CachePort } from './cache.port';

/**
 * Provides CACHE (CachePort), adapter chosen by CACHE_ADAPTER. The redis
 * adapter reuses the shared REDIS_CLIENT connection from RedisModule.
 */
@Module({})
export class CacheModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (CacheModule.root ??= {
      module: CacheModule,
      imports: [
        importWhenSelected(
          'CACHE_ADAPTER',
          'redis',
          'redis',
          RedisConnectionModule,
        ),
      ],
      providers: [
        {
          provide: CACHE,
          inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
          useFactory: (config: ConfigService, redis?: Redis): CachePort => {
            const adapter = selectAdapter(
              'CACHE_ADAPTER',
              config.get<string>('CACHE_ADAPTER'),
              CACHE_ADAPTERS,
              'redis',
            );
            if (adapter === 'disabled') return new DisabledCacheAdapter();
            if (!redis)
              throw new Error('CACHE_ADAPTER=redis requires RedisModule');
            return new CacheClient(new RedisCacheStore(redis));
          },
        },
        CacheHealthIndicator,
      ],
      exports: [CACHE, CacheHealthIndicator],
    });
  }
}
