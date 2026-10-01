import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Pulsar from 'pulsar-client';
import { createLogger } from '../../../common/observability/logger';
import { PULSAR_CLIENT } from './pulsar.constants';

export { PULSAR_CLIENT };

const logger = createLogger('messaging');

/** Routes the native client's log lines through the logger port. */
export function pulsarLog(
  level: Pulsar.LogLevel,
  file: string,
  line: number,
  message: string,
): void {
  const fields = { 'code.filepath': file, 'code.lineno': line };
  switch (level) {
    case Pulsar.LogLevel.ERROR:
      logger.error('pulsar-client', message, undefined, fields);
      return;
    case Pulsar.LogLevel.WARN:
      logger.warn('pulsar-client', message, fields);
      return;
    case Pulsar.LogLevel.INFO:
      logger.debug('pulsar-client', message, fields);
      return;
    default:
      logger.debug('pulsar-client', message, fields);
  }
}

/**
 * Owns the Pulsar client. Imported by the messaging capability only when
 * MESSAGING_ADAPTER=pulsar.
 *
 * The client is closed in onApplicationShutdown, which Nest runs after every
 * onModuleDestroy — so consumers and producers built on it are released
 * first. The client is native: left open, its threads keep the process alive
 * after app.close(), and a SIGTERM'd pod would not exit on its own.
 */
@Module({
  providers: [
    {
      provide: PULSAR_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pulsar.Client({
          serviceUrl: config.getOrThrow<string>('PULSAR_SERVICE_URL'),
          log: pulsarLog,
        }),
    },
  ],
  exports: [PULSAR_CLIENT],
})
export class PulsarConnectionModule implements OnApplicationShutdown {
  constructor(@Inject(PULSAR_CLIENT) private readonly client: Pulsar.Client) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}
