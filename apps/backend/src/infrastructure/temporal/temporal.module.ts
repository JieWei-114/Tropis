import { Module, Global, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, Connection } from '@temporalio/client';
import { TEMPORAL_CLIENT } from './temporal.constants';
import { TemporalService } from './temporal.service';

@Global()
@Module({
  providers: [
    {
      provide: TEMPORAL_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const address = config.get<string>(
          'TEMPORAL_ADDRESS',
          'localhost:7233',
        );
        const namespace = config.get<string>('TEMPORAL_NAMESPACE', 'default');
        const connection = await Connection.connect({ address });
        return new Client({ connection, namespace });
      },
    },
    TemporalService,
  ],
  exports: [TemporalService],
})
export class TemporalModule implements OnApplicationShutdown {
  constructor(private readonly temporalService: TemporalService) {}

  async onApplicationShutdown() {
    await this.temporalService.close();
  }
}
