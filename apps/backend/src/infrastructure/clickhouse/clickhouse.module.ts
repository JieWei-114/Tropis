import {
  Module,
  Global,
  Injectable,
  Inject,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@clickhouse/client';

export const CLICKHOUSE_CLIENT = 'CLICKHOUSE_CLIENT';

@Injectable()
class ClickhouseCleanupService implements OnApplicationShutdown {
  constructor(
    @Inject(CLICKHOUSE_CLIENT)
    private readonly client: ReturnType<typeof createClient>,
  ) {}

  async onApplicationShutdown() {
    await this.client.close().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: CLICKHOUSE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createClient({
          url: config.get<string>('CLICKHOUSE_HOST', 'http://localhost:8123'),
          username: config.get<string>('CLICKHOUSE_USER', 'default'),
          password: config.get<string>('CLICKHOUSE_PASSWORD', ''),
          database: config.get<string>('CLICKHOUSE_DATABASE', 'logs'),
        }),
    },
    ClickhouseCleanupService,
  ],
  exports: [CLICKHOUSE_CLIENT],
})
export class ClickhouseModule {}
