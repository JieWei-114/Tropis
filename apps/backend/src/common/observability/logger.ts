import { hostname } from 'os';
import { Injectable } from '@nestjs/common';
import pino, {
  type DestinationStream,
  type Logger as PinoInstance,
  type LoggerOptions,
} from 'pino';
import { isAppErrorLike } from '../errors/app-error';
import { currentRequestContext } from './request-context';
import {
  REDACTED,
  REDACTED_HEADER_PATHS,
  redact,
  scrubText,
} from './redaction';
import { serviceInfo } from './service-info';
import { activeSpanIds } from './trace-context';

/**
 * The logger port. Every record is one JSON line in the OTel log data model:
 *
 *   time, level, msg, service.name, service.version, deployment.environment,
 *   service.role, host.name, process.pid, trace_id, span_id, tenant.id
 *   (when known), module, event, and for errors error.code, error.type,
 *   error.message and error.stack (stack only at debug level or outside
 *   production).
 *
 * `event` is `<module>.<what-happened>` in kebab-case, e.g.
 * `outbox.relay-lock-unavailable`. Levels: `error` needs a human, `warn` is
 * degraded but handled, `info` is a lifecycle or business milestone, `debug`
 * is diagnostics. Application code logs only through createLogger()
 * (enforced by lint); the remaining records written through Nest's Logger
 * come from the framework and its libraries, and get module `nest` and the
 * event `nest.<context>` (e.g. `nest.router-explorer`). Only a record with
 * neither an event nor a context falls back to `<module>.unclassified`.
 *
 * Redaction (redaction.ts) runs on every record, whichever API wrote it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface RootLoggerOptions {
  level?: string;
  /** Where records go; stdout when omitted. */
  destination?: DestinationStream;
  /** Human-readable output through pino-pretty (development). */
  pretty?: boolean;
  env?: NodeJS.ProcessEnv;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Module of records the framework writes through Nest's Logger. */
export const NEST_MODULE = 'nest';

/** `OutboxRelay` -> `outbox-relay`, `user_processor` -> `user-processor`. */
export function toKebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * `<module>.<what-happened>` for an event name given either in full or as
 * just the part after the module; each segment is kebab-cased.
 */
export function eventName(module: string, event: string): string {
  const mod = toKebab(module) || 'app';
  const rest = event.startsWith(`${mod}.`)
    ? event.slice(mod.length + 1)
    : event;
  const what = rest
    .split('.')
    .map((s) => toKebab(s))
    .filter(Boolean)
    .join('.');
  return `${mod}.${what || 'unclassified'}`;
}

export function isValidEventName(value: string): boolean {
  const parts = value.split('.');
  return parts.length >= 2 && parts.every((p) => KEBAB.test(p));
}

interface ErrorFields {
  'error.code'?: string;
  'error.type': string;
  'error.message': string;
  'error.stack'?: string;
}

function describe(value: object): string {
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** OTel `error.*` fields for any thrown value. */
export function errorFields(err: unknown, includeStack: boolean): ErrorFields {
  if (typeof err === 'object' && err !== null) {
    const e = err as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
      code?: unknown;
    };
    const out: ErrorFields = {
      'error.type':
        typeof e.name === 'string' && e.name
          ? e.name
          : (err.constructor?.name ?? 'Error'),
      'error.message': scrubText(
        typeof e.message === 'string' ? e.message : describe(err),
      ),
    };
    if (isAppErrorLike(err)) out['error.code'] = err.code;
    else if (typeof e.code === 'string' || typeof e.code === 'number') {
      out['error.code'] = String(e.code);
    }
    if (includeStack && typeof e.stack === 'string') {
      out['error.stack'] = scrubText(e.stack);
    }
    return out;
  }
  return { 'error.type': typeof err, 'error.message': scrubText(String(err)) };
}

/**
 * Shapes one record: fills `module` and `event`, turns an `err`/`error`
 * value (or a bare `stack` from Nest's Logger.error) into `error.*`, and
 * redacts. Exported for tests.
 */
export function formatRecord(
  obj: Record<string, unknown>,
  includeStack: boolean,
): Record<string, unknown> {
  const { err, error, stack, context, module, event, ...rest } = obj;
  const hasModule = typeof module === 'string' && module.length > 0;
  const hasEvent = typeof event === 'string' && event.length > 0;
  const framework =
    !hasModule && !hasEvent && typeof context === 'string' && context
      ? toKebab(context)
      : undefined;
  const mod = hasModule ? toKebab(module) : framework ? NEST_MODULE : 'app';
  const out: Record<string, unknown> = redact(rest) as Record<string, unknown>;
  out.module = mod;
  out.event =
    hasEvent && isValidEventName(event)
      ? event
      : eventName(mod, hasEvent ? event : (framework ?? 'unclassified'));
  const thrown = err ?? error;
  if (thrown !== undefined) {
    Object.assign(out, errorFields(thrown, includeStack));
  } else if (typeof stack === 'string') {
    out['error.type'] = 'Error';
    out['error.message'] = '';
    if (includeStack) out['error.stack'] = scrubText(stack);
  }
  return out;
}

/** Trace, span and tenant of the work in progress. */
export function contextFields(): Record<string, string> {
  const fields: Record<string, string> = {};
  const span = activeSpanIds();
  const ctx = currentRequestContext();
  const traceId = span?.traceId ?? ctx?.traceId;
  if (traceId) fields.trace_id = traceId;
  if (span) fields.span_id = span.spanId;
  if (ctx?.tenantId) fields['tenant.id'] = ctx.tenantId;
  return fields;
}

export function buildPinoOptions(opts: RootLoggerOptions = {}): LoggerOptions {
  const env = opts.env ?? process.env;
  const info = serviceInfo(env);
  const level = opts.level ?? env.LOG_LEVEL ?? 'info';
  const includeStack =
    info.environment !== 'production' || level === 'debug' || level === 'trace';
  return {
    level,
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      'service.name': info.name,
      'service.version': info.version,
      'deployment.environment': info.environment,
      'service.role': info.role,
      'host.name': hostname(),
      'process.pid': process.pid,
    },
    redact: { paths: REDACTED_HEADER_PATHS, censor: REDACTED },
    serializers: {
      msg: (m: unknown) => (typeof m === 'string' ? scrubText(m) : m),
    },
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => formatRecord(obj, includeStack),
    },
    mixin: () => contextFields(),
  };
}

export function createRootLogger(opts: RootLoggerOptions = {}): PinoInstance {
  const options = buildPinoOptions(opts);
  if (opts.destination) return pino(options, opts.destination);
  if (opts.pretty) {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { singleLine: true } },
    });
  }
  return pino(options);
}

let root: PinoInstance | undefined;

/** The process-wide pino instance every logger API writes through. */
export function getRootLogger(): PinoInstance {
  root ??= createRootLogger();
  return root;
}

/** Replaces the root logger (ObservabilityModule at boot, tests). */
export function configureRootLogger(
  opts: RootLoggerOptions = {},
): PinoInstance {
  root = createRootLogger(opts);
  return root;
}

/**
 * Structured logger for one module. `event` may be given in full
 * (`outbox.relay-lock-unavailable`) or without the module prefix
 * (`relay-lock-unavailable`); it is normalised to kebab-case either way.
 */
export class AppLogger {
  constructor(
    readonly module: string,
    private readonly base: () => PinoInstance = getRootLogger,
  ) {}

  debug(event: string, msg: string, fields?: LogFields): void {
    this.write('debug', event, msg, fields);
  }

  info(event: string, msg: string, fields?: LogFields): void {
    this.write('info', event, msg, fields);
  }

  warn(event: string, msg: string, fields?: LogFields, err?: unknown): void {
    this.write('warn', event, msg, fields, err);
  }

  error(event: string, msg: string, err?: unknown, fields?: LogFields): void {
    this.write('error', event, msg, fields, err);
  }

  private write(
    level: LogLevel,
    event: string,
    msg: string,
    fields: LogFields = {},
    err?: unknown,
  ): void {
    const record: LogFields = {
      ...fields,
      module: toKebab(this.module),
      event: eventName(this.module, event),
    };
    if (err !== undefined) record.err = err;
    if (typeof fields.tenantId === 'string') {
      record['tenant.id'] = fields.tenantId;
      delete record.tenantId;
    }
    this.base()[level](record, msg);
  }
}

/** Nest-injectable source of module loggers. */
@Injectable()
export class LoggerFactory {
  forModule(module: string): AppLogger {
    return new AppLogger(module);
  }
}

/** A module logger for code outside Nest DI (adapters, interceptors). */
export function createLogger(module: string): AppLogger {
  return new AppLogger(module);
}
