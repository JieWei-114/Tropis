import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import {
  Code,
  ConnectError,
  createClient,
  type Client,
} from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { randomUUID } from 'crypto';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { validationExceptionFactory } from '../src/common/errors';
import { RpcServer } from '../src/infrastructure/rpc/rpc-server.service';
import { OpsServer } from '../src/modules/health/ops-server';
import { AuthService } from '../src/gen/auth/v1/auth_pb';
import { UserService } from '../src/gen/user/v1/user_pb';
import { Health } from '../src/gen/grpc/health/v1/health_pb';
import {
  TENANT_DIRECTORY,
  type TenantDirectory,
} from '../src/common/tenant/tenant-directory.port';
import { toTenantId } from '../src/common/keyspace';

// E2E tests boot the whole AppModule against real infrastructure, so every
// capability the backend connects to must be running: `make up`, then
// `pnpm test:e2e`. `make test-e2e` does both.
//
// jest-e2e.json sets forceExit: when bootstrap fails part-way (infrastructure
// down), the drivers created before the failure keep reconnecting and Nest
// does not close a module that never finished initialising, so nothing the
// test holds can stop them. A successful run closes everything in afterAll.

const TENANT = 'e2e';
const tenantHeaders = { 'x-tenant-id': TENANT };

describe('Application (e2e)', () => {
  let app: INestApplication<App>;
  let rpc: RpcServer;
  let ops: string;
  let auth: Client<typeof AuthService>;
  let users: Client<typeof UserService>;
  let health: Client<typeof Health>;
  let adminToken: string;
  // Kept outside beforeAll: if setup times out while the module is still
  // connecting, afterAll can still close it, so no connection or timer
  // outlives the run and keeps Jest from exiting.
  let compiling: Promise<TestingModule> | undefined;

  beforeAll(async () => {
    compiling = Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const moduleFixture = await compiling;

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: validationExceptionFactory,
      }),
    );
    await app.init();

    // The RPC listeners are what the gRPC cases exercise, so start them here
    // on ephemeral ports rather than relying on a separately running backend.
    const opsPort = await app.get(OpsServer).listen(0, '127.0.0.1');
    ops = `http://127.0.0.1:${opsPort}`;

    rpc = app.get(RpcServer);
    const { publicPort } = await rpc.start({
      publicPort: 0,
      internalPort: 0,
      host: '127.0.0.1',
      reflection: false,
      corsOrigins: [],
    });
    const transport = createGrpcTransport({
      baseUrl: `http://127.0.0.1:${publicPort}`,
    });
    auth = createClient(AuthService, transport);
    users = createClient(UserService, transport);
    health = createClient(Health, transport);

    // Sign-up and login need a registered, active tenant open to self
    // sign-up; FindAll is admin-only (OPA `list`) and the token verifier
    // reads roles from the member record, so register a real user, grant
    // admin, and log in.
    await app.get<TenantDirectory>(TENANT_DIRECTORY).register({
      id: toTenantId(TENANT),
      name: 'E2E',
      selfSignup: true,
    });
    const email = `e2e-admin-${randomUUID()}@example.com`;
    const password = 'Password123!';
    await users.create(
      { name: 'E2E Admin', email, password },
      { headers: tenantHeaders },
    );
    await app
      .get<Connection>(getConnectionToken())
      .collection('users')
      .updateOne(
        { email, tenantId: TENANT },
        { $addToSet: { roles: 'admin' } },
      );
    const login = await auth.login(
      { email, password },
      { headers: tenantHeaders },
    );
    adminToken = login.accessToken;
  });

  afterAll(async () => {
    await rpc?.stop();
    if (app) {
      await app.close();
      return;
    }
    const moduleFixture = await compiling?.catch(() => undefined);
    await moduleFixture?.close();
  });

  const codeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (err: unknown) => (err instanceof ConnectError ? err.code : err),
    );

  // ── HTTP ─────────────────────────────────────────────────────────────────

  describe('GET /api/health', () => {
    it('returns a health status object', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('status');
    });
  });

  describe('GET /api/metrics', () => {
    it('is not served on the public HTTP port', async () => {
      const res = await request(app.getHttpServer()).get('/api/metrics');
      expect(res.status).toBe(404);
    });
  });

  // ── Ops port ─────────────────────────────────────────────────────────────

  describe('ops port', () => {
    it('answers /livez', async () => {
      const res = await fetch(`${ops}/livez`);
      expect(res.status).toBe(200);
    });

    it('reports readiness on /readyz', async () => {
      const res = await fetch(`${ops}/readyz`);
      expect([200, 503]).toContain(res.status);
      expect(await res.json()).toHaveProperty('status');
    });

    it('serves Prometheus text metrics on /metrics', async () => {
      const res = await fetch(`${ops}/metrics`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('nodejs_version_info');
    });
  });

  // ── RPC (gRPC protocol) ──────────────────────────────────────────────────

  describe('grpc.health.v1.Health/Check', () => {
    it('reports SERVING', async () => {
      const res = await health.check({});
      expect(res.status).toBe(1);
    });
  });

  describe('AuthService/Login', () => {
    it('returns UNAUTHENTICATED on wrong credentials', async () => {
      expect(
        await codeOf(
          auth.login(
            { email: 'nobody@example.com', password: 'wrongpass' },
            { headers: tenantHeaders },
          ),
        ),
      ).toBe(Code.Unauthenticated);
    });

    it('returns UNAUTHENTICATED on an empty request', async () => {
      expect(
        await codeOf(
          auth.login({ email: '', password: '' }, { headers: tenantHeaders }),
        ),
      ).toBe(Code.Unauthenticated);
    });

    it('returns INVALID_ARGUMENT without a tenant', async () => {
      expect(
        await codeOf(
          auth.login({ email: 'nobody@example.com', password: 'wrongpass' }),
        ),
      ).toBe(Code.InvalidArgument);
    });
  });

  describe('UserService/Create', () => {
    it('refuses self sign-up in a tenant that is not registered', async () => {
      expect(
        await codeOf(
          users.create(
            {
              name: 'Intruder',
              email: `intruder-${randomUUID()}@example.com`,
              password: 'Password123!',
            },
            { headers: { 'x-tenant-id': `unregistered-${randomUUID()}` } },
          ),
        ),
      ).toBe(Code.PermissionDenied);
    });
  });

  describe('UserService/FindAll', () => {
    it('rejects a call without a token', async () => {
      expect(await codeOf(users.findAll({ page: 1, limit: 10 }))).toBe(
        Code.Unauthenticated,
      );
    });

    it('returns a paginated users list for an admin', async () => {
      const res = await users.findAll(
        { page: 1, limit: 10 },
        { headers: { authorization: `Bearer ${adminToken}` } },
      );
      expect(Array.isArray(res.users)).toBe(true);
      expect(res.page).toBe(1);
    });
  });
});
