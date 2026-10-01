import {
  DynamicModule,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { selectAdapter } from '../capability';
import { importWhenSelected } from '../capability/conditional-import';
import {
  REDIS_CLIENT,
  RedisConnectionModule,
} from '../connections/redis/redis-connection.module';
import { LocalRealtimeAdapter } from './adapters/local/local-realtime.adapter';
import { RedisRealtimeAdapter } from './adapters/redis/redis-realtime.adapter';
import { RealtimeHealthIndicator } from './realtime.health';
import {
  REALTIME,
  REALTIME_ADAPTERS,
  REALTIME_TRANSPORT,
  type RealtimeAdapter,
} from './realtime.port';
import { realtimeChannelKey } from './realtime.rooms';

const REALTIME_ADAPTER_INSTANCE = Symbol('REALTIME_ADAPTER_INSTANCE');

@Injectable()
class RealtimeShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(REALTIME_ADAPTER_INSTANCE)
    private readonly adapter: RealtimeAdapter,
  ) {}

  onApplicationShutdown(): Promise<void> {
    return this.adapter.close();
  }
}

/**
 * Provides REALTIME (RealtimePort, for producers in any role) and
 * REALTIME_TRANSPORT (for the gateway that holds sockets), one adapter
 * chosen by REALTIME_ADAPTER.
 */
@Module({})
export class RealtimeModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (RealtimeModule.root ??= {
      module: RealtimeModule,
      imports: [
        importWhenSelected(
          'REALTIME_ADAPTER',
          'redis',
          'redis',
          RedisConnectionModule,
        ),
      ],
      providers: [
        {
          provide: REALTIME_ADAPTER_INSTANCE,
          inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
          useFactory: (
            config: ConfigService,
            redis?: Redis,
          ): RealtimeAdapter => {
            const adapter = selectAdapter(
              'REALTIME_ADAPTER',
              config.get<string>('REALTIME_ADAPTER'),
              REALTIME_ADAPTERS,
              'redis',
            );
            if (adapter === 'local') return new LocalRealtimeAdapter();
            if (!redis)
              throw new Error('REALTIME_ADAPTER=redis requires RedisModule');
            return new RedisRealtimeAdapter(redis, realtimeChannelKey());
          },
        },
        { provide: REALTIME, useExisting: REALTIME_ADAPTER_INSTANCE },
        { provide: REALTIME_TRANSPORT, useExisting: REALTIME_ADAPTER_INSTANCE },
        RealtimeShutdown,
        RealtimeHealthIndicator,
      ],
      exports: [REALTIME, REALTIME_TRANSPORT, RealtimeHealthIndicator],
    });
  }
}
