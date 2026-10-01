import {
  makeTelemetryFilterString,
  Runtime,
  type Logger,
  type LogLevel,
  type LogMetadata,
} from '@temporalio/worker';
import { createLogger, toKebab } from '../../../../common/observability/logger';

const logger = createLogger('workflow');

function fields(meta: LogMetadata = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key === 'error' || key === 'err') continue;
    out[`temporal.${toKebab(key).replace(/-/g, '_')}`] = value;
  }
  return out;
}

/** The Temporal SDK's logger, writing through the logger port. */
export class TemporalLogger implements Logger {
  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    const err = (meta?.error ?? meta?.err) as unknown;
    switch (level) {
      case 'ERROR':
        logger.error('temporal-sdk', message, err, fields(meta));
        return;
      case 'WARN':
        logger.warn('temporal-sdk', message, fields(meta), err);
        return;
      case 'INFO':
        logger.info('temporal-sdk', message, fields(meta));
        return;
      default:
        logger.debug('temporal-sdk', message, fields(meta));
    }
  }

  trace(message: string, meta?: LogMetadata): void {
    this.log('TRACE', message, meta);
  }

  debug(message: string, meta?: LogMetadata): void {
    this.log('DEBUG', message, meta);
  }

  info(message: string, meta?: LogMetadata): void {
    this.log('INFO', message, meta);
  }

  warn(message: string, meta?: LogMetadata): void {
    this.log('WARN', message, meta);
  }

  error(message: string, meta?: LogMetadata): void {
    this.log('ERROR', message, meta);
  }
}

let installed = false;

/**
 * Installs the Temporal runtime once per process, before the first worker
 * connection, with the SDK's logs (and the native core's, forwarded at
 * WARN and above) going through the logger port instead of stderr.
 */
export function installTemporalRuntime(): void {
  if (installed) return;
  installed = true;
  try {
    Runtime.install({
      logger: new TemporalLogger(),
      telemetryOptions: {
        logging: {
          filter: makeTelemetryFilterString({ core: 'WARN' }),
          forward: {},
        },
      },
    });
  } catch (err) {
    logger.warn(
      'temporal-runtime-installed',
      'Temporal runtime was already installed; its default logger stays',
      {},
      err,
    );
  }
}
