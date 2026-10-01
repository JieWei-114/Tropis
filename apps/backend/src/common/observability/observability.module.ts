import {
  Global,
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { IncomingMessage, ServerResponse } from 'http';
import { LoggerModule } from 'nestjs-pino';
import { GlobalExceptionFilter } from '../filters/http-exception.filter';
import { HttpMetricsMiddleware } from '../middleware/http-metrics.middleware';
import {
  configureRootLogger,
  LoggerFactory,
  type RootLoggerOptions,
} from './logger';
import { requestTraceId } from './trace-context';

type Req = IncomingMessage & { id?: unknown; originalUrl?: string };

const TRACKING_INGEST_PATH = /^\/api\/v1\/track(\/|$)/;

/** The request path without its query string, which can carry codes and tokens. */
function pathOnly(req: Req): string {
  const url = req.originalUrl ?? req.url ?? '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * One request record in OTel semantic-convention fields. The client
 * address, user agent, headers and query are deliberately absent.
 */
function httpRecord(
  req: Req,
  res: ServerResponse,
  event: string,
  durationMs: unknown,
): Record<string, unknown> {
  return {
    module: 'http',
    event,
    trace_id: typeof req.id === 'string' ? req.id : undefined,
    'http.request.method': req.method,
    'url.path': pathOnly(req),
    'http.response.status_code': res.statusCode,
    'http.server.request.duration':
      typeof durationMs === 'number' ? durationMs / 1000 : undefined,
  };
}

function logLevel(
  req: Req,
  res: ServerResponse,
  err: Error | undefined,
): 'warn' | 'info' | 'debug' {
  if (err || res.statusCode >= 500) return 'warn';
  if (res.statusCode < 400 && TRACKING_INGEST_PATH.test(pathOnly(req))) {
    return 'debug';
  }
  return 'info';
}

/**
 * Logging, error rendering and HTTP metrics for the whole app:
 *
 * - the process-wide pino logger (logger.ts) behind nestjs-pino, so Nest's
 *   Logger, PinoLogger and AppLogger all write the same record shape;
 * - pino-http request logs whose request id is the trace id, one record per
 *   request with method, path (no query), status and duration only;
 *   successful tracking ingest logs at debug, being the hottest route;
 * - the RFC 9457 exception filter as a global filter;
 * - HttpMetricsMiddleware on every route.
 */
@Global()
@Module({})
export class ObservabilityModule implements NestModule {
  static forRoot(options: RootLoggerOptions = {}): DynamicModule {
    const env = options.env ?? process.env;
    const root = configureRootLogger({
      pretty:
        !options.destination &&
        env.NODE_ENV !== 'production' &&
        env.LOG_FORMAT !== 'json',
      ...options,
    });
    return {
      module: ObservabilityModule,
      global: true,
      imports: [
        LoggerModule.forRoot({
          forRoutes: ['*path'],
          pinoHttp: {
            logger: root,
            genReqId: (req) => requestTraceId(req),
            quietReqLogger: true,
            quietResLogger: true,
            customLogLevel: (req, res, err) => logLevel(req as Req, res, err),
            customSuccessObject: (
              req: Req,
              res: ServerResponse,
              val: { responseTime?: unknown },
            ) =>
              httpRecord(req, res, 'http.request-completed', val.responseTime),
            customErrorObject: (
              req: Req,
              res: ServerResponse,
              _err: Error,
              val: { responseTime?: unknown },
            ) => httpRecord(req, res, 'http.request-failed', val.responseTime),
          },
        }),
      ],
      providers: [
        LoggerFactory,
        { provide: APP_FILTER, useFactory: () => new GlobalExceptionFilter() },
      ],
      exports: [LoggerFactory, LoggerModule],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*path');
  }
}
