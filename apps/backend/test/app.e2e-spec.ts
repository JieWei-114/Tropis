import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

// E2E tests require all infrastructure (MongoDB, Redis, etc.) to be running.
// Start with: docker compose -f infra/docker/docker-compose.yml up -d
// Then: pnpm test:e2e

describe('Application (e2e)', () => {
  let app: INestApplication<App>;
  let grpcClient: any;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    // Build a gRPC client pointed at the running server
    const pkgDef = protoLoader.loadSync(
      [
        join(__dirname, '..', '..', '..', 'proto', 'auth', 'v1', 'auth.proto'),
        join(__dirname, '..', '..', '..', 'proto', 'user', 'v1', 'user.proto'),
      ],
      {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      },
    );
    const proto = grpc.loadPackageDefinition(pkgDef) as any;
    grpcClient = {
      auth: new proto.tropis.auth.v1.AuthService(
        'localhost:50051',
        grpc.credentials.createInsecure(),
      ),
      user: new proto.tropis.user.v1.UserService(
        'localhost:50051',
        grpc.credentials.createInsecure(),
      ),
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // ── HTTP — health + metrics (the only two REST endpoints remaining) ──────────

  describe('GET /api/health', () => {
    it('returns a health status object', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('status');
    });
  });

  describe('GET /api/metrics', () => {
    it('returns Prometheus text metrics', async () => {
      const res = await request(app.getHttpServer()).get('/api/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toContain('nodejs_version_info');
    });
  });

  // ── gRPC — Auth ──────────────────────────────────────────────────────────────

  describe('gRPC AuthService/Login', () => {
    it('returns UNAUTHENTICATED on wrong credentials', (done) => {
      grpcClient.auth.Login(
        { email: 'nobody@example.com', password: 'wrongpass' },
        (err: grpc.ServiceError) => {
          expect(err).toBeTruthy();
          expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
          done();
        },
      );
    });

    it('returns UNAUTHENTICATED on empty request', (done) => {
      grpcClient.auth.Login(
        { email: '', password: '' },
        (err: grpc.ServiceError) => {
          expect(err).toBeTruthy();
          done();
        },
      );
    });
  });

  // ── gRPC — User ──────────────────────────────────────────────────────────────

  describe('gRPC UserService/FindAll', () => {
    it('returns a paginated users list', (done) => {
      grpcClient.user.FindAll(
        { page: 1, limit: 10 },
        (err: grpc.ServiceError, res: any) => {
          expect(err).toBeNull();
          expect(res).toHaveProperty('users');
          expect(Array.isArray(res.users)).toBe(true);
          done();
        },
      );
    });
  });
});
