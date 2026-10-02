import { Writable } from 'stream';
import {
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  ValidationPipe,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { ThrottlerException } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { ProblemDetails } from '@tropis/shared';
import { register } from 'prom-client';
import { AppError, validationExceptionFactory } from '../../errors';
import { CorrelationIdMiddleware } from '../../middleware/correlation-id.middleware';
import { ObservabilityModule } from '../../observability/observability.module';
import {
  HTTP_REQUESTS_METRIC,
  HTTP_DURATION_METRIC,
} from '../../observability/metrics';
import {
  installTracing,
  TRACE_ID,
  TRACEPARENT,
} from '../../observability/__tests__/harness';

class CreateThingDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(3)
  name!: string;
}

@Controller('things')
class ThingsController {
  @Get(':id')
  get(@Param('id') id: string) {
    if (id === 'missing') throw new NotFoundException('USER_NOT_FOUND');
    if (id === 'boom') throw new Error('mongo down at 10.0.0.5');
    if (id === 'gone')
      throw new AppError('USER_NOT_FOUND', { detail: 'User 42 is gone.' });
    return { id };
  }

  @Post()
  create(@Body() dto: CreateThingDto) {
    return dto;
  }
}

@Controller('limits')
class LimitsController {
  @Get('throttled')
  throttled() {
    throw new ThrottlerException();
  }

  @Get('limited')
  limited() {
    throw new AppError('RATE_LIMITED', {
      metadata: { retryAfterSeconds: '17' },
    });
  }
}

@Controller('v1/track')
class TrackController {
  @Post()
  track() {
    return { accepted: 1 };
  }
}

@Controller('strict')
class StrictController {
  @Post()
  create(@Body() dto: CreateThingDto) {
    return dto;
  }
}

@Controller('health')
class HealthController {
  @Get()
  check() {
    const details = {
      mongo: { status: 'up' },
      redis: { status: 'down', message: 'connect ECONNREFUSED 10.0.0.5:6379' },
    };
    throw new ServiceUnavailableException({
      status: 'error',
      info: { mongo: details.mongo },
      error: { redis: details.redis },
      details,
    });
  }
}

const records: Array<Record<string, unknown>> = [];
const destination = new Writable({
  write(chunk: Buffer, _enc, done) {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim())
        records.push(JSON.parse(line) as Record<string, unknown>);
    }
    done();
  },
});

@Module({
  imports: [
    ObservabilityModule.forRoot({
      destination,
      level: 'debug',
      env: { NODE_ENV: 'test' },
    }),
  ],
  controllers: [
    ThingsController,
    HealthController,
    StrictController,
    LimitsController,
    TrackController,
  ],
})
class TestAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*path');
  }
}

describe('HTTP errors, trace ids and RED metrics', () => {
  let app: INestApplication<App>;
  const otel = installTracing();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await otel.shutdown();
  });

  beforeEach(() => {
    records.length = 0;
  });

  const http = () => request(app.getHttpServer());

  it('answers RFC 9457 with the catalog code for a bare-string code', async () => {
    const res = await http()
      .get('/api/things/missing?token=abc')
      .set('traceparent', TRACEPARENT);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.headers['x-request-id']).toBe(TRACE_ID);
    expect(res.body).toEqual({
      type: 'https://errors.tropis.dev/user-not-found',
      title: 'The user was not found.',
      status: 404,
      instance: '/api/things/missing',
      code: 'USER_NOT_FOUND',
      traceId: TRACE_ID,
      retryable: false,
    });
  });

  it('renders an AppError with its detail', async () => {
    const res = await http().get('/api/things/gone');
    expect(res.body).toMatchObject({
      code: 'USER_NOT_FOUND',
      detail: 'User 42 is gone.',
      status: 404,
    });
    expect((res.body as ProblemDetails).traceId).toBe(
      res.headers['x-request-id'],
    );
  });

  it('hides an unexpected error and logs it with the same trace id', async () => {
    const res = await http()
      .get('/api/things/boom')
      .set('traceparent', TRACEPARENT)
      .set('x-request-id', 'client-chosen');
    expect(res.status).toBe(500);
    expect(res.headers['x-request-id']).toBe(TRACE_ID);
    expect(res.body).toMatchObject({
      type: 'https://errors.tropis.dev/internal',
      title: 'An internal error occurred.',
      code: 'INTERNAL',
      traceId: TRACE_ID,
      retryable: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');

    const logged = records.find((r) => r.event === 'http.unhandled-error');
    expect(logged).toMatchObject({
      level: 'error',
      module: 'http',
      trace_id: TRACE_ID,
      'error.type': 'Error',
      'error.message': 'mongo down at 10.0.0.5',
    });
    const completed = records.find((r) => r.event === 'http.request-failed');
    expect(completed).toMatchObject({ trace_id: TRACE_ID, level: 'warn' });
    expect(completed).not.toHaveProperty('req');
  });

  // Reproduces the gap: the request log carried the full URL with its query
  // (OAuth codes, tokens), the client address and user agent, under
  // pino-http's own field names.
  it('logs a request with OTel fields, the path without query and no client details', async () => {
    await http()
      .get('/api/things/ok?code=secret-code&state=s')
      .set('user-agent', 'probe-agent/1.0')
      .set('x-forwarded-for', '198.51.100.7');
    const done = records.find((r) => r.event === 'http.request-completed');
    expect(done).toMatchObject({
      level: 'info',
      'http.request.method': 'GET',
      'url.path': '/api/things/ok',
      'http.response.status_code': 200,
    });
    const text = JSON.stringify(done);
    expect(text).not.toContain('secret-code');
    expect(text).not.toContain('probe-agent');
    expect(text).not.toContain('198.51.100.7');
    expect(text).not.toContain('127.0.0.1');
    expect(done).not.toHaveProperty('req');
    expect(done).not.toHaveProperty('res');
  });

  it('logs successful tracking ingest at debug, not info', async () => {
    await http().post('/api/v1/track').send({});
    const done = records.find((r) => r.event === 'http.request-completed');
    expect(done).toMatchObject({ level: 'debug', 'url.path': '/api/v1/track' });
  });

  // Reproduces the gap: an unknown route answered "Cannot GET /api/x?query",
  // echoing the caller's URL and query back.
  it('answers an unknown route without echoing the URL', async () => {
    const res = await http().get('/api/nowhere/at-all?secret=s3cret');
    expect(res.status).toBe(404);
    expect((res.body as ProblemDetails).code).toBe('NOT_FOUND');
    expect(res.body).not.toHaveProperty('detail');
    expect(JSON.stringify(res.body)).not.toContain('s3cret');
    expect(JSON.stringify(res.body)).not.toContain('Cannot');
  });

  it('answers a throttled request with RATE_LIMITED, no library text, and Retry-After', async () => {
    const res = await http().get('/api/limits/throttled');
    expect(res.status).toBe(429);
    expect((res.body as ProblemDetails).code).toBe('RATE_LIMITED');
    expect(res.body).not.toHaveProperty('detail');
    expect(JSON.stringify(res.body)).not.toMatch(/ThrottlerException/i);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('sets Retry-After from an AppError retryAfterSeconds', async () => {
    const res = await http().get('/api/limits/limited');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('17');
  });

  it('maps default ValidationPipe output to field violations', async () => {
    const res = await http()
      .post('/api/things')
      .send({ email: 'nope', name: 'ab', extra: 1 });
    expect(res.status).toBe(400);
    expect((res.body as ProblemDetails).code).toBe('VALIDATION_FAILED');
    expect((res.body as ProblemDetails).errors).toEqual(
      expect.arrayContaining([
        { field: 'email', description: 'email must be an email' },
        { field: 'extra', description: 'property extra should not exist' },
        expect.objectContaining({ field: 'name' }),
      ]),
    );
  });

  it('keeps probe names and statuses of a failed health check, nothing else', async () => {
    const res = await http().get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'HEALTH_CHECK_FAILED',
      status: 503,
      retryable: true,
      checks: [
        { name: 'mongo', status: 'up' },
        { name: 'redis', status: 'down' },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    expect(
      records.find((r) => r.event === 'http.health-check-failed'),
    ).toMatchObject({
      level: 'warn',
    });
  });

  it('records RED metrics by route template and status class', async () => {
    await http().get('/api/things/ok');
    await http().get('/api/nowhere');
    const counter = await register.getSingleMetric(HTTP_REQUESTS_METRIC)!.get();
    const routes = counter.values.map((v) => v.labels);
    expect(routes).toEqual(
      expect.arrayContaining([
        { method: 'GET', route: '/api/things/:id', status_class: '2xx' },
        { method: 'GET', route: '/api/things/:id', status_class: '4xx' },
        { method: 'GET', route: '/api/things/:id', status_class: '5xx' },
        { method: 'GET', route: 'unmatched', status_class: '4xx' },
      ]),
    );
    for (const labels of routes) {
      expect(String(labels.route)).not.toMatch(/missing|boom|gone|ok$/);
    }
    expect(register.getSingleMetric(HTTP_DURATION_METRIC)).toBeDefined();
  });

  it('uses exact field paths with validationExceptionFactory', async () => {
    const strict = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();
    const strictApp: INestApplication<App> = strict.createNestApplication({
      logger: false,
    });
    strictApp.useGlobalPipes(
      new ValidationPipe({ exceptionFactory: validationExceptionFactory }),
    );
    await strictApp.init();
    const res = await request(strictApp.getHttpServer())
      .post('/strict')
      .send({ email: 'x', name: 'abcd' });
    await strictApp.close();
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'email', description: 'email must be an email' }],
    });
  });
});
