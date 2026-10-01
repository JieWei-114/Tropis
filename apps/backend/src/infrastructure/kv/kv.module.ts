import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { selectAdapter } from '../capability';
import { importWhenSelected } from '../capability/conditional-import';
import {
  AEROSPIKE_CLIENT,
  AerospikeConnectionModule,
} from '../connections/aerospike/aerospike-connection.module';
import {
  REDIS_CLIENT,
  RedisConnectionModule,
} from '../connections/redis/redis-connection.module';
import {
  AerospikeKvAdapter,
  type AerospikeKvClient,
} from './adapters/aerospike/aerospike-kv.adapter';
import { DisabledKvAdapter } from './adapters/disabled/disabled-kv.adapter';
import { RedisKvAdapter } from './adapters/redis/redis-kv.adapter';
import { KvHealthIndicator } from './kv.health';
import { KV, KV_ADAPTERS, type KvPort } from './kv.port';

/**
 * Provides KV (KvPort), adapter chosen by KV_ADAPTER. Only the selected
 * adapter's connection is opened: REDIS_CLIENT for `redis`,
 * AEROSPIKE_CLIENT (null when unreachable, reported `down`) for `aerospike`.
 */
@Module({})
export class KvModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (KvModule.root ??= {
      module: KvModule,
      imports: [
        importWhenSelected(
          'KV_ADAPTER',
          'redis',
          'redis',
          RedisConnectionModule,
        ),
        importWhenSelected(
          'KV_ADAPTER',
          'redis',
          'aerospike',
          AerospikeConnectionModule,
        ),
      ],
      providers: [
        {
          provide: KV,
          inject: [
            ConfigService,
            { token: REDIS_CLIENT, optional: true },
            { token: AEROSPIKE_CLIENT, optional: true },
          ],
          useFactory: (
            config: ConfigService,
            redis?: Redis,
            aerospike?: AerospikeKvClient | null,
          ): KvPort => {
            const adapter = selectAdapter(
              'KV_ADAPTER',
              config.get<string>('KV_ADAPTER'),
              KV_ADAPTERS,
              'redis',
            );
            switch (adapter) {
              case 'disabled':
                return new DisabledKvAdapter();
              case 'aerospike':
                return new AerospikeKvAdapter(aerospike ?? null);
              case 'redis':
                if (!redis)
                  throw new Error('KV_ADAPTER=redis requires RedisModule');
                return new RedisKvAdapter(redis);
            }
          },
        },
        KvHealthIndicator,
      ],
      exports: [KV, KvHealthIndicator],
    });
  }
}
