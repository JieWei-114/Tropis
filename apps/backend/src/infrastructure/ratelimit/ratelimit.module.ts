import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { selectAdapter } from '../capability';
import { importWhenSelected } from '../capability/conditional-import';
import {
  REDIS_CLIENT,
  RedisConnectionModule,
} from '../connections/redis/redis-connection.module';
import { DisabledRateLimitAdapter } from './adapters/disabled/disabled-ratelimit.adapter';
import { RedisRateLimitAdapter } from './adapters/redis/redis-ratelimit.adapter';
import { RateLimitHealthIndicator } from './ratelimit.health';
import {
  RATE_LIMIT,
  RATE_LIMIT_ADAPTERS,
  type RateLimitPort,
} from './ratelimit.port';

/** Provides RATE_LIMIT (RateLimitPort), adapter chosen by RATE_LIMIT_ADAPTER. */
@Module({})
export class RateLimitModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (RateLimitModule.root ??= {
      module: RateLimitModule,
      imports: [
        importWhenSelected(
          'RATE_LIMIT_ADAPTER',
          'redis',
          'redis',
          RedisConnectionModule,
        ),
      ],
      providers: [
        {
          provide: RATE_LIMIT,
          inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
          useFactory: (config: ConfigService, redis?: Redis): RateLimitPort => {
            const adapter = selectAdapter(
              'RATE_LIMIT_ADAPTER',
              config.get<string>('RATE_LIMIT_ADAPTER'),
              RATE_LIMIT_ADAPTERS,
              'redis',
            );
            if (adapter === 'disabled') return new DisabledRateLimitAdapter();
            if (!redis) {
              throw new Error('RATE_LIMIT_ADAPTER=redis requires RedisModule');
            }
            return new RedisRateLimitAdapter(redis);
          },
        },
        RateLimitHealthIndicator,
      ],
      exports: [RATE_LIMIT, RateLimitHealthIndicator],
    });
  }
}
