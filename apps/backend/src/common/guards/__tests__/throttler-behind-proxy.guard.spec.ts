import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { ProblemDetails } from '@tropis/shared';
import { GlobalExceptionFilter } from '../../filters/http-exception.filter';
import { ThrottlerBehindProxyGuard } from '../throttler-behind-proxy.guard';

@Controller('auth')
class AuthRoutes {
  @Get('login')
  @Throttle({ auth: {} })
  login() {
    return { ok: true };
  }

  @Get('me')
  me() {
    return { ok: true };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', ttl: 60_000, limit: 100 },
        { name: 'auth', ttl: 60_000, limit: 2 },
      ],
    }),
  ],
  controllers: [AuthRoutes],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard }],
})
class TestModule {}

describe('ThrottlerBehindProxyGuard', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterEach(() => app.close());

  const get = (path: string) => request(app.getHttpServer()).get(path);

  // Reproduces the gap: the auth limit applied to every /api/auth/* route,
  // not only the credential routes that declare it.
  it('applies a named throttler only to routes that declare it', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await get('/auth/me')).status).toBe(200);
    }
  });

  // Reproduces the gap: a named throttler answered with Retry-After-auth, a
  // header no client reads, and the library's own message.
  it('answers RATE_LIMITED with a standard Retry-After header', async () => {
    await get('/auth/login');
    await get('/auth/login');
    const res = await get('/auth/login');
    expect(res.status).toBe(429);
    expect((res.body as ProblemDetails).code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(res.headers).not.toHaveProperty('retry-after-auth');
    expect(JSON.stringify(res.body)).not.toMatch(/ThrottlerException/);
  });
});
