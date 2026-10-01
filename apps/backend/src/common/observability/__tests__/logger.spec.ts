import {
  PinoLogger,
  __resetOutOfContextForTests,
} from 'nestjs-pino/PinoLogger';
import { context, trace } from '@opentelemetry/api';
import { AppError } from '../../errors';
import {
  AppLogger,
  createLogger,
  eventName,
  formatRecord,
  isValidEventName,
  LoggerFactory,
  toKebab,
} from '../logger';
import { hashEmail, redact, REDACTED, scrubText } from '../redaction';
import { runWithRequestContext } from '../request-context';
import { captureLogs, installTracing, TRACE_ID } from './harness';

describe('log record shape', () => {
  it('carries the OTel resource, context and event fields', () => {
    const { records } = captureLogs('debug', {
      NODE_ENV: 'staging',
      OTEL_SERVICE_NAME: 'svc',
      SERVICE_VERSION: '1.2.3',
    });
    runWithRequestContext({ traceId: TRACE_ID, tenantId: 'acme' }, () =>
      createLogger('outbox').info('relay-started', 'Relay started', {
        batch: 50,
      }),
    );
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r).toMatchObject({
      level: 'info',
      msg: 'Relay started',
      'service.name': 'svc',
      'service.version': '1.2.3',
      'deployment.environment': 'staging',
      'service.role': 'all',
      trace_id: TRACE_ID,
      'tenant.id': 'acme',
      module: 'outbox',
      event: 'outbox.relay-started',
      batch: 50,
    });
    expect(r.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(r).not.toHaveProperty('pid');
    expect(r).not.toHaveProperty('hostname');
  });

  it('records error fields, with the stack outside production', () => {
    const { records } = captureLogs('info', { NODE_ENV: 'development' });
    createLogger('user').error(
      'lookup-failed',
      'Lookup failed',
      new AppError('USER_NOT_FOUND'),
    );
    expect(records[0]).toMatchObject({
      level: 'error',
      event: 'user.lookup-failed',
      'error.code': 'USER_NOT_FOUND',
      'error.type': 'AppError',
      'error.message': 'The user was not found.',
    });
    expect(records[0]['error.stack']).toEqual(
      expect.stringContaining('AppError'),
    );
  });

  it('omits the stack in production unless the level is debug', () => {
    const prod = captureLogs('info', { NODE_ENV: 'production' });
    createLogger('user').error('x', 'x', new Error('boom'));
    expect(prod.records[0]).not.toHaveProperty(['error.stack']);
    expect(prod.records[0]['error.message']).toBe('boom');

    const debug = captureLogs('debug', { NODE_ENV: 'production' });
    createLogger('user').error('x', 'x', new Error('boom'));
    expect(debug.records[0]).toHaveProperty(['error.stack']);
  });

  it('adds span_id and the active span trace id', () => {
    const otel = installTracing();
    const { records } = captureLogs();
    const span = trace.getTracer('t').startSpan('op');
    context.with(trace.setSpan(context.active(), span), () =>
      createLogger('m').debug('e', 'x'),
    );
    span.end();
    expect(records[0].trace_id).toBe(span.spanContext().traceId);
    expect(records[0].span_id).toBe(span.spanContext().spanId);
    return otel.shutdown();
  });

  it('classifies framework records written through Nest by their context', () => {
    const { records, logger } = captureLogs();
    __resetOutOfContextForTests();
    const pino = new PinoLogger({ pinoHttp: { logger } });
    pino.setContext('RouterExplorer');
    pino.info({ route: '/api' }, 'Mapped');
    expect(records.at(-1)).toMatchObject({
      module: 'nest',
      event: 'nest.router-explorer',
      route: '/api',
    });
  });

  it('marks a record with neither event nor context as unclassified', () => {
    expect(formatRecord({ msg: 'x' }, false)).toMatchObject({
      module: 'app',
      event: 'app.unclassified',
    });
  });

  it('applies redaction to every record', () => {
    const { records } = captureLogs();
    createLogger('auth').info(
      'login-succeeded',
      'Signed in alice@example.com',
      {
        email: 'alice@example.com',
        password: 'hunter2',
        nested: { refreshToken: 'r', apiKey: 'k', ok: 1 },
        headers: { authorization: 'Bearer x', cookie: 'c' },
      },
    );
    const r = records[0];
    expect(r.msg).toBe(`Signed in ${hashEmail('alice@example.com')}`);
    expect(r.email).toBe(hashEmail('alice@example.com'));
    expect(r.password).toBe(REDACTED);
    expect(r.nested).toEqual({
      refreshToken: REDACTED,
      apiKey: REDACTED,
      ok: 1,
    });
    expect(r.headers).toEqual({ authorization: REDACTED, cookie: REDACTED });
    expect(JSON.stringify(r)).not.toContain('alice@example.com');
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('is injectable through LoggerFactory', () => {
    expect(new LoggerFactory().forModule('x')).toBeInstanceOf(AppLogger);
  });
});

describe('event names', () => {
  it('prefixes the module and kebab-cases each segment', () => {
    expect(eventName('outbox', 'relayLockUnavailable')).toBe(
      'outbox.relay-lock-unavailable',
    );
    expect(eventName('outbox', 'outbox.relay-lock-unavailable')).toBe(
      'outbox.relay-lock-unavailable',
    );
    expect(eventName('OutboxRelay', '')).toBe('outbox-relay.unclassified');
    expect(toKebab('HTTPServer_error')).toBe('http-server-error');
  });

  it('validates <module>.<what-happened>', () => {
    expect(isValidEventName('outbox.relay-lock-unavailable')).toBe(true);
    expect(isValidEventName('outbox')).toBe(false);
    expect(isValidEventName('Outbox.Relay')).toBe(false);
  });

  it('replaces an invalid event given directly to pino', () => {
    expect(formatRecord({ event: 'Bad Event', module: 'm' }, false).event).toBe(
      'm.bad-event',
    );
  });
});

describe('redaction', () => {
  it('matches secret keys regardless of case and separators', () => {
    expect(
      redact({
        Refresh_Token: 'a',
        'x-service-token': 'b',
        passwordHash: 'c',
        clientSecret: 'd',
        jwtSecret: 'e',
        tokenType: 'bearer',
        userEmail: 'Bob@Example.com',
      }),
    ).toEqual({
      Refresh_Token: REDACTED,
      'x-service-token': REDACTED,
      passwordHash: REDACTED,
      clientSecret: REDACTED,
      jwtSecret: REDACTED,
      tokenType: 'bearer',
      userEmail: hashEmail('bob@example.com'),
    });
  });

  it('scrubs emails inside text and arrays, leaves class instances alone', () => {
    expect(scrubText('to a@b.io and c@d.co')).not.toMatch(/@/);
    expect(redact(['x@y.dev'])).toEqual([hashEmail('x@y.dev')]);
    const buf = Buffer.from('x');
    expect((redact({ buf }) as { buf: Buffer }).buf).toBe(buf);
  });
});
