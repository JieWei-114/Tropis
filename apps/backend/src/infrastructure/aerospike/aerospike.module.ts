import { Module, Global, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service';

import { AEROSPIKE_CLIENT } from './aerospike.constants';

export { AEROSPIKE_CLIENT };

const logger = new Logger('AerospikeModule');

/**
 * Ultra-fast in-memory key-value store used for user session tracking.
 *
 * Why Aerospike instead of Redis for sessions?
 *   - Aerospike stores the index in RAM but data on SSD → cheaper at scale
 *   - Sub-millisecond reads even at billions of records
 *   - Built-in TTL per record (perfect for sessions)
 *   - Redis is used here for application cache (user objects, stats)
 *     Aerospike is used for auth sessions (userId → sessionToken mapping)
 *
 * Install:  pnpm add aerospike --filter @tropis/backend
 *           (requires aerospike-c-client native lib — see README)
 *
 * The module uses dynamic require() so the app still compiles and starts
 * if aerospike is not installed — it just logs a warning and returns null.
 */
@Global()
@Module({
  providers: [
    {
      provide: AEROSPIKE_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        try {
          // Dynamic import — avoids hard compile-time dependency
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const Aerospike = require('aerospike') as typeof import('aerospike');

          const hosts = config.get<string>('AEROSPIKE_HOSTS', 'localhost:3000');

          const client = Aerospike.client({
            hosts,
            log: { level: Aerospike.log.INFO },
          });

          await client.connect();
          logger.log(`Aerospike connected → ${hosts}`);
          return client;
        } catch {
          logger.warn(
            'Aerospike not available (package not installed or service down) — session tracking disabled',
          );
          return null;
        }
      },
    },
    SessionService,
  ],
  exports: [AEROSPIKE_CLIENT, SessionService],
})
export class AerospikeModule {}
