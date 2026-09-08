import { Module, Global, Logger, OnApplicationShutdown } from '@nestjs/common';
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
        // Degrade gracefully: if Temporal isn't running, disable workflow
        // features instead of crash-looping the whole app at boot.
        try {
          const connection = await Connection.connect({
            address,
            connectTimeout: '3s',
          });
          return new Client({ connection, namespace });
        } catch (err) {
          new Logger('TemporalModule').warn(
            `Temporal not available at ${address} — workflow features disabled (${(err as Error).message})`,
          );
          return null;
        }
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
