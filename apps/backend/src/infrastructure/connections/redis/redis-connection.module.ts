import {
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

export { REDIS_CLIENT };

/**
 * A command that has not answered by then rejects, so a hung Redis fails
 * the caller (which degrades or retries) instead of holding it forever.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 5_000;
export const REDIS_CONNECT_TIMEOUT_MS = 10_000;

@Injectable()
class RedisCleanupService implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown() {
    await this.redis.quit().catch(() => undefined);
  }
}

/**
 * The shared Redis client of the redis adapters (cache, kv, lock,
 * ratelimit, dedup, realtime). Imported by those capability modules only
 * when their adapter selector names `redis`, so a process opens it at most
 * once and only when one of them uses it.
 */
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
          connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        }),
    },
    RedisCleanupService,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisConnectionModule {}
