import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../../common/observability/logger';
import { AEROSPIKE_CLIENT } from './aerospike.constants';

export { AEROSPIKE_CLIENT };

const logger = createLogger('kv');

/**
 * Owns the Aerospike client used by the kv aerospike adapter; imported by
 * the kv capability only when KV_ADAPTER=aerospike.
 *
 * The driver is a native addon loaded with require() so the app still starts
 * where it is not installed or the server is down: the client is then null
 * and the adapter reports `down`.
 */
@Module({
  providers: [
    {
      provide: AEROSPIKE_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        let client: { connect(): Promise<unknown>; close(): void } | undefined;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const Aerospike = require('aerospike') as typeof import('aerospike');

          const hosts = config.getOrThrow<string>('AEROSPIKE_HOSTS');

          client = Aerospike.client({
            hosts,
            log: { level: Aerospike.log.INFO },
          });

          await client.connect();
          logger.info('aerospike-connected', 'Aerospike connected', {
            'server.address': hosts,
          });
          return client;
        } catch {
          // A client whose connect() failed still owns native threads that
          // would keep the process alive after app.close().
          try {
            client?.close();
          } catch {
            // Already torn down.
          }
          logger.warn(
            'aerospike-unavailable',
            'Aerospike not available (package not installed or service down)',
          );
          return null;
        }
      },
    },
  ],
  exports: [AEROSPIKE_CLIENT],
})
export class AerospikeConnectionModule implements OnApplicationShutdown {
  constructor(
    @Inject(AEROSPIKE_CLIENT)
    private readonly client: { close(): void } | null,
  ) {}

  // The client is native: left open, it keeps the process alive after
  // app.close(). It is null when Aerospike was unavailable at startup.
  onApplicationShutdown(): void {
    this.client?.close();
  }
}
