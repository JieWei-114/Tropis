import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { selectAdapter } from '../capability';
import { importWhenSelected } from '../capability/conditional-import';
import {
  REDIS_CLIENT,
  RedisConnectionModule,
} from '../connections/redis/redis-connection.module';
import { DisabledDedupAdapter } from './adapters/disabled/disabled-dedup.adapter';
import { RedisDedupAdapter } from './adapters/redis/redis-dedup.adapter';
import { DedupHealthIndicator } from './dedup.health';
import { DEDUP, DEDUP_ADAPTERS, type DedupPort } from './dedup.port';

/** Provides DEDUP (DedupPort), adapter chosen by DEDUP_ADAPTER. */
@Module({})
export class DedupModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (DedupModule.root ??= {
      module: DedupModule,
      imports: [
        importWhenSelected(
          'DEDUP_ADAPTER',
          'redis',
          'redis',
          RedisConnectionModule,
        ),
      ],
      providers: [
        {
          provide: DEDUP,
          inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
          useFactory: (config: ConfigService, redis?: Redis): DedupPort => {
            const adapter = selectAdapter(
              'DEDUP_ADAPTER',
              config.get<string>('DEDUP_ADAPTER'),
              DEDUP_ADAPTERS,
              'redis',
            );
            if (adapter === 'disabled') return new DisabledDedupAdapter();
            if (!redis)
              throw new Error('DEDUP_ADAPTER=redis requires RedisModule');
            return new RedisDedupAdapter(redis);
          },
        },
        DedupHealthIndicator,
      ],
      exports: [DEDUP, DedupHealthIndicator],
    });
  }
}
