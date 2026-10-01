import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createHttpApp, httpSurface } from '../http.surface';

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      ignoreEnvFile: true,
      load: [() => ({ NODE_ENV: 'production', PORT: 0 })],
    }),
  ],
  controllers: [PingController],
})
class PingModule {}

describe('HTTP surface CORS', () => {
  let app: NestExpressApplication;
  let stop: () => Promise<void>;
  const origin = 'http://localhost:5173';

  beforeAll(async () => {
    process.env.CORS_ORIGIN = origin;
    app = await createHttpApp(PingModule);
    app.useLogger(false);
    stop = (await httpSurface(app, {})) as () => Promise<void>;
  });

  afterAll(async () => {
    await stop?.();
    await app?.close();
    delete process.env.CORS_ORIGIN;
  });

  // Reproduces the gap: a browser could not read x-request-id or
  // retry-after from a cross-origin response.
  it('allows credentials for listed origins and exposes request id and Retry-After', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/ping')
      .set('Origin', origin);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toBe(
      'x-request-id,retry-after',
    );
  });

  it('grants nothing to an unlisted origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/ping')
      .set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
