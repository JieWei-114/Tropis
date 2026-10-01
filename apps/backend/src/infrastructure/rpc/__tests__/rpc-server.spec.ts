import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import {
  Code,
  ConnectError,
  createClient,
  type Transport,
} from '@connectrpc/connect';
import {
  createConnectTransport,
  createGrpcTransport,
  createGrpcWebTransport,
} from '@connectrpc/connect-node';
import { AppError } from '../../../common/errors';
import { TOKEN_VERIFIER } from '../../../common/auth/token-verifier.port';
import { AuthService as AuthDomainService } from '../../../modules/auth/services/auth.service';
import {
  signAccessToken,
  testTokenVerifier,
} from '../../../modules/auth/__tests__/token-fixtures';
import { TOKEN_REVOKED_KEY } from '../../../modules/auth/constants/auth.constants';
import { RpcServer, type RpcServerAddresses } from '../rpc-server.service';
import { RpcAuthzService } from '../rpc-authz.service';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { UserSearchService } from '../../../modules/user/services/user-search.service';
import { POLICY } from '../../policy/policy.port';
import { LoginLockoutService } from '../../../modules/auth/services/login-lockout.service';
import { TenantContext } from '../../../common/tenant/tenant.context';
import { AuditLogService } from '../../../common/audit/audit-log.service';
import { AUDIT_OUTCOME } from '../../../common/audit/audit.constants';
import { UserService } from '../../../modules/user/services/user.service';
import { UserRpcController } from '../../../modules/user/controllers/user.rpc.controller';
import { UserInternalRpcController } from '../../../modules/user/controllers/user-internal.rpc.controller';
import { AuthRpcController } from '../../../modules/auth/controllers/auth.rpc.controller';
import { HealthRpcController } from '../../../modules/health/controllers/health.rpc.controller';
import { UserStatus } from '../../../modules/user/constants/user.enums';
import { UserService as UserServiceDesc } from '../../../gen/user/v1/user_pb';
import { UserInternalService } from '../../../gen/user/internal/v1/user_internal_pb';
import { AuthService } from '../../../gen/auth/v1/auth_pb';
import { HealthService } from '../../../gen/health/v1/health_pb';
import {
  Health,
  HealthCheckResponse_ServingStatus,
} from '../../../gen/grpc/health/v1/health_pb';
import * as reflectionV1 from '../../../gen/grpc/reflection/v1/reflection_pb';
import * as reflectionV1alpha from '../../../gen/grpc/reflection/v1alpha/reflection_pb';
import {
  BadRequestSchema,
  ErrorInfoSchema,
} from '../../../gen/google/rpc/error_details_pb';

const SERVICE_TOKEN = 'internal-secret';
const ALLOWED_ORIGIN = 'http://localhost:5173';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const traceparent = (traceId = TRACE_ID) => `00-${traceId}-00f067aa0ba902b7-01`;

const token = (claims: Record<string, unknown>) =>
  signAccessToken({ sub: 'user-1', roles: ['admin'], ...claims });

const mockUser = {
  id: 'user-1',
  name: 'Alice',
  email: 'alice@example.com',
  status: UserStatus.ACTIVE,
  roles: [],
  loginCount: 2,
};

/**
 * Boots the real RpcServer on ephemeral ports with the real handlers and
 * interceptors, and mocked domain services, then calls it over the wire with
 * each protocol it speaks.
 */
describe('RpcServer (live listeners)', () => {
  let moduleRef: TestingModule;
  let server: RpcServer;
  let ports: Required<RpcServerAddresses>;
  let tenantCtx: TenantContext;
  const userService = {
    findAll: jest.fn(),
    create: jest.fn(),
    signUp: jest.fn(),
    update: jest.fn(),
    findById: jest.fn(),
    findByEmailWithPassword: jest.fn(),
  };
  const auditLog = { record: jest.fn() };
  const opa = { allow: jest.fn() };
  const lockout = { assertRpcLoginAllowed: jest.fn() };
  const authDomain = { loginAccessOnly: jest.fn() };
  let verifier: ReturnType<typeof testTokenVerifier>;

  const url = (port: number) => `http://127.0.0.1:${port}`;
  const connect = (port: number): Transport =>
    createConnectTransport({ baseUrl: url(port), httpVersion: '1.1' });
  const grpc = (port: number): Transport =>
    createGrpcTransport({ baseUrl: url(port) });
  const grpcWeb = (port: number): Transport =>
    createGrpcWebTransport({ baseUrl: url(port), httpVersion: '1.1' });

  const start = async (reflection: boolean) => {
    verifier = testTokenVerifier();
    moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        RpcServer,
        RpcAuthzService,
        AuthorizationService,
        TenantContext,
        UserRpcController,
        UserInternalRpcController,
        AuthRpcController,
        HealthRpcController,
        { provide: UserService, useValue: userService },
        { provide: UserSearchService, useValue: {} },
        { provide: AuditLogService, useValue: auditLog },
        { provide: POLICY, useValue: opa },
        { provide: LoginLockoutService, useValue: lockout },
        { provide: AuthDomainService, useValue: authDomain },
        { provide: TOKEN_VERIFIER, useValue: verifier.verifier },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) =>
              key === 'SERVICE_TOKEN' ? SERVICE_TOKEN : 'unused',
            get: () => undefined,
          },
        },
      ],
    }).compile();
    server = moduleRef.get(RpcServer);
    tenantCtx = moduleRef.get(TenantContext);
    ports = (await server.start({
      publicPort: 0,
      internalPort: 0,
      host: '127.0.0.1',
      reflection,
      corsOrigins: [ALLOWED_ORIGIN],
    })) as Required<RpcServerAddresses>;
  };

  const expectCode = async (promise: Promise<unknown>, code: Code) => {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(code);
    return err as ConnectError;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    opa.allow.mockResolvedValue(true);
    lockout.assertRpcLoginAllowed.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await server?.stop();
    await moduleRef?.close();
  });

  describe('with reflection', () => {
    beforeEach(() => start(true));

    it('answers the Connect protocol over HTTP/1.1', async () => {
      const res = await createClient(
        HealthService,
        connect(ports.publicPort),
      ).check({});
      expect(res.status).toBe('ok');
    });

    it('answers gRPC over h2c with the token, tenant and correlation id bound', async () => {
      userService.findAll.mockImplementation(() =>
        Promise.resolve({
          data: [{ ...mockUser, name: tenantCtx.tenantId }],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
        }),
      );
      let requestId: string | null = null;
      const res = await createClient(
        UserServiceDesc,
        grpc(ports.publicPort),
      ).findAll(
        {},
        {
          headers: {
            authorization: `Bearer ${token({ tenantId: 'acme' })}`,
            traceparent: traceparent(),
            'x-request-id': 'req-42',
          },
          onHeader: (h) => (requestId = h.get('x-request-id')),
        },
      );

      expect(res.users[0].name).toBe('acme');
      // The correlation id is the trace id; a caller's x-request-id is never adopted.
      expect(requestId).toBe(TRACE_ID);
      expect(opa.allow).toHaveBeenCalledWith(
        expect.objectContaining({ resource: 'user', action: 'list' }),
      );
    });

    it('answers gRPC-Web over HTTP/1.1 and keeps handler error codes', async () => {
      authDomain.loginAccessOnly.mockRejectedValue(
        new AppError('AUTH_INVALID_CREDENTIALS'),
      );
      const err = await expectCode(
        createClient(AuthService, grpcWeb(ports.publicPort)).login(
          { email: 'nobody@example.com', password: 'x' },
          { headers: { 'x-tenant-id': 'acme' } },
        ),
        Code.Unauthenticated,
      );
      expect(err.rawMessage).toBe('The email or password is incorrect.');
      expect(authDomain.loginAccessOnly).toHaveBeenCalledWith(
        'acme',
        { email: 'nobody@example.com', password: 'x' },
        'unknown',
      );
      expect(err.metadata.get('x-request-id')).toBeTruthy();
    });

    it('rejects a login that names no tenant', async () => {
      const err = await expectCode(
        createClient(AuthService, connect(ports.publicPort)).login({
          email: 'a@example.com',
          password: 'x',
        }),
        Code.InvalidArgument,
      );
      expect(err.findDetails(ErrorInfoSchema)[0]?.reason).toBe(
        'TENANT_REQUIRED',
      );
      expect(authDomain.loginAccessOnly).not.toHaveBeenCalled();
    });

    it('rejects an X-Tenant-ID that contradicts the token', async () => {
      const err = await expectCode(
        createClient(UserServiceDesc, connect(ports.publicPort)).findAll(
          {},
          {
            headers: {
              authorization: `Bearer ${token({ tenantId: 'acme' })}`,
              'x-tenant-id': 'globex',
            },
          },
        ),
        Code.PermissionDenied,
      );
      expect(err.findDetails(ErrorInfoSchema)[0]?.reason).toBe(
        'TENANT_MISMATCH',
      );
      expect(userService.findAll).not.toHaveBeenCalled();
    });

    it('rejects a revoked token over the wire', async () => {
      await verifier.kv.set(TOKEN_REVOKED_KEY.global('j-revoked'), true, {
        ttlSeconds: 60,
      });
      const err = await expectCode(
        createClient(UserServiceDesc, connect(ports.publicPort)).findAll(
          {},
          {
            headers: {
              authorization: `Bearer ${token({ jti: 'j-revoked' })}`,
            },
          },
        ),
        Code.Unauthenticated,
      );
      expect(err.findDetails(ErrorInfoSchema)[0]?.reason).toBe(
        'AUTH_TOKEN_REVOKED',
      );
    });

    it('rejects a protected call without a token', async () => {
      const err = await expectCode(
        createClient(UserServiceDesc, connect(ports.publicPort)).findAll({}),
        Code.Unauthenticated,
      );
      expect(err.rawMessage).toBe('Missing authorization token');
      expect(userService.findAll).not.toHaveBeenCalled();
    });

    it('maps a domain HttpException to its status code and audits the failure', async () => {
      userService.signUp.mockRejectedValue(
        new ConflictException({
          code: 'USER_ALREADY_EXISTS',
          message: 'A user with this email already exists',
        }),
      );

      const err = await expectCode(
        createClient(UserServiceDesc, grpc(ports.publicPort)).create(
          { name: 'A', email: 'a@example.com', password: 'password1' },
          { headers: { traceparent: traceparent(), 'x-tenant-id': 'acme' } },
        ),
        Code.AlreadyExists,
      );

      // The machine code travels as google.rpc.ErrorInfo, not a message prefix.
      expect(err.rawMessage).toBe('A user with this email already exists');
      expect(err.findDetails(ErrorInfoSchema)[0]?.reason).toBe(
        'USER_ALREADY_EXISTS',
      );
      expect(err.metadata.get('trace-id')).toBe(TRACE_ID);
      expect(auditLog.record).toHaveBeenCalledWith({
        action: 'user.create',
        actorUserId: '',
        tenantId: 'acme',
        resource: 'UserRpcController.create',
        transport: 'rpc',
        traceId: TRACE_ID,
        outcome: AUDIT_OUTCOME.ERROR,
        error: 'A user with this email already exists',
        timestamp: expect.any(Date),
      });
    });

    it('audits a successful mutation with the verified actor and tenant', async () => {
      userService.update.mockResolvedValue(mockUser);
      await createClient(UserServiceDesc, connect(ports.publicPort)).update(
        { id: 'user-9', name: 'Bob' },
        {
          headers: {
            authorization: `Bearer ${token({ sub: 'user-9', tenantId: 'acme' })}`,
          },
        },
      );

      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.update',
          actorUserId: 'user-9',
          tenantId: 'acme',
          resource: 'UserRpcController.update',
          transport: 'rpc',
          outcome: AUDIT_OUTCOME.SUCCESS,
        }),
      );
    });

    it('does not audit handlers without @Audited', async () => {
      await createClient(HealthService, connect(ports.publicPort)).check({});
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    // Reproduces the mail relay: Create took a comma-separated address list
    // and markup in the name, because RPC requests never met a validator.
    it('rejects an invalid request with VALIDATION_FAILED and field violations', async () => {
      const err = await expectCode(
        createClient(UserServiceDesc, connect(ports.publicPort)).create(
          {
            name: '<b>Eve</b>',
            email: 'a@example.com, b@example.com',
            password: 'password123',
          },
          { headers: { 'x-tenant-id': 'acme' } },
        ),
        Code.InvalidArgument,
      );
      expect(err.findDetails(ErrorInfoSchema)[0]?.reason).toBe(
        'VALIDATION_FAILED',
      );
      const fields = err
        .findDetails(BadRequestSchema)[0]
        ?.fieldViolations.map((v) => v.field);
      expect(fields).toEqual(expect.arrayContaining(['name', 'email']));
      expect(userService.signUp).not.toHaveBeenCalled();
      expect(userService.create).not.toHaveBeenCalled();
    });

    it('reports violations under the proto field names', async () => {
      const err = await expectCode(
        createClient(UserServiceDesc, connect(ports.publicPort)).findAll(
          { pageToken: 'x'.repeat(600) },
          {
            headers: {
              authorization: `Bearer ${token({ tenantId: 'acme' })}`,
            },
          },
        ),
        Code.InvalidArgument,
      );
      expect(
        err.findDetails(BadRequestSchema)[0]?.fieldViolations[0]?.field,
      ).toBe('page_token');
    });

    it('maps an unexpected error to INTERNAL', async () => {
      userService.findAll.mockRejectedValue(new Error('mongo down'));
      const err = await expectCode(
        createClient(UserServiceDesc, connect(ports.publicPort)).findAll(
          {},
          { headers: { authorization: `Bearer ${token({})}` } },
        ),
        Code.Internal,
      );
      // Internal details are logged, never sent.
      expect(err.rawMessage).toBe('An internal error occurred.');
    });

    it('keeps the internal tier off the public listener', async () => {
      await expectCode(
        createClient(
          UserInternalService,
          grpc(ports.publicPort),
        ).getUserByEmail(
          { email: 'alice@example.com' },
          { headers: { 'x-service-token': SERVICE_TOKEN } },
        ),
        Code.Unimplemented,
      );
      expect(userService.findByEmailWithPassword).not.toHaveBeenCalled();
    });

    it('serves the internal tier on the internal listener with a service identity', async () => {
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUser,
        passwordHash: 'hash',
      });
      const client = createClient(
        UserInternalService,
        grpc(ports.internalPort),
      );

      const res = await client.getUserByEmail(
        { email: 'alice@example.com' },
        {
          headers: { 'x-service-token': SERVICE_TOKEN, 'x-tenant-id': 'acme' },
        },
      );
      expect(res.loginCount).toBe(2);
      expect(userService.findByEmailWithPassword).toHaveBeenCalledWith(
        'acme',
        'alice@example.com',
      );

      await expectCode(
        client.getUserByEmail({ email: 'alice@example.com' }),
        Code.PermissionDenied,
      );
    });

    it('keeps public services off the internal listener', async () => {
      await expectCode(
        createClient(AuthService, grpc(ports.internalPort)).login({
          email: 'a@example.com',
          password: 'x',
        }),
        Code.Unimplemented,
      );
    });

    it.each(['publicPort', 'internalPort'] as const)(
      'serves both health services on the %s',
      async (which) => {
        const port = ports[which];
        const res = await createClient(Health, grpc(port)).check({});
        expect(res.status).toBe(HealthCheckResponse_ServingStatus.SERVING);
        const named = await createClient(Health, grpc(port)).check({
          service: HealthService.typeName,
        });
        expect(named.status).toBe(HealthCheckResponse_ServingStatus.SERVING);
        await expectCode(
          createClient(Health, grpc(port)).check({ service: 'nope.Service' }),
          Code.NotFound,
        );
        expect(
          (await createClient(HealthService, grpc(port)).check({})).status,
        ).toBe('ok');
      },
    );

    const reflect = async (
      port: number,
      requests: reflectionV1.ServerReflectionRequest['messageRequest'][],
    ) => {
      const client = createClient(reflectionV1.ServerReflection, grpc(port));
      async function* input() {
        for (const messageRequest of requests) yield { messageRequest };
      }
      const out: reflectionV1.ServerReflectionResponse[] = [];
      for await (const res of client.serverReflectionInfo(input())) {
        out.push(res);
      }
      return out;
    };

    const listed = (res: reflectionV1.ServerReflectionResponse) =>
      res.messageResponse.case === 'listServicesResponse'
        ? res.messageResponse.value.service.map((s) => s.name)
        : [];

    it('reflects only the public services on the public listener', async () => {
      const [res] = await reflect(ports.publicPort, [
        { case: 'listServices', value: '' },
      ]);
      const names = listed(res);
      expect(names).toEqual(
        expect.arrayContaining([
          AuthService.typeName,
          UserServiceDesc.typeName,
          HealthService.typeName,
          Health.typeName,
          reflectionV1.ServerReflection.typeName,
          reflectionV1alpha.ServerReflection.typeName,
        ]),
      );
      expect(names).not.toContain(UserInternalService.typeName);

      const [missing] = await reflect(ports.publicPort, [
        { case: 'fileContainingSymbol', value: UserInternalService.typeName },
      ]);
      expect(missing.messageResponse.case).toBe('errorResponse');
    });

    it('reflects the internal service on the internal listener', async () => {
      const [res] = await reflect(ports.internalPort, [
        { case: 'listServices', value: '' },
      ]);
      expect(listed(res)).toContain(UserInternalService.typeName);
      expect(listed(res)).not.toContain(UserServiceDesc.typeName);
    });

    it('returns descriptors for symbols, methods and file names', async () => {
      const responses = await reflect(ports.publicPort, [
        { case: 'fileContainingSymbol', value: UserServiceDesc.typeName },
        {
          case: 'fileContainingSymbol',
          value: `${UserServiceDesc.typeName}.FindAll`,
        },
        { case: 'fileContainingSymbol', value: 'tropis.user.v1.UserResponse' },
        { case: 'fileByFilename', value: 'auth/v1/auth.proto' },
        { case: 'fileByFilename', value: 'nope.proto' },
      ]);

      const fileNames = responses.map((r) =>
        r.messageResponse.case === 'fileDescriptorResponse'
          ? r.messageResponse.value.fileDescriptorProto.map(
              (b) => fromBinary(FileDescriptorProtoSchema, b).name,
            )
          : r.messageResponse.case,
      );
      expect(fileNames).toEqual([
        ['user/v1/user.proto'],
        ['user/v1/user.proto'],
        ['user/v1/user.proto'],
        ['auth/v1/auth.proto'],
        'errorResponse',
      ]);
    });

    it('answers the v1alpha protocol too', async () => {
      const client = createClient(
        reflectionV1alpha.ServerReflection,
        grpc(ports.publicPort),
      );
      async function* input() {
        yield {
          messageRequest: { case: 'listServices' as const, value: '' },
        };
      }
      for await (const res of client.serverReflectionInfo(input())) {
        expect(res.messageResponse.case).toBe('listServicesResponse');
      }
    });

    describe('CORS', () => {
      const preflight = (origin: string) =>
        fetch(`${url(ports.publicPort)}/${HealthService.typeName}/Check`, {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization,content-type',
          },
        });

      it('answers a preflight from an allowed origin', async () => {
        const res = await preflight(ALLOWED_ORIGIN);
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe(
          ALLOWED_ORIGIN,
        );
        const allowHeaders = (
          res.headers.get('access-control-allow-headers') ?? ''
        ).toLowerCase();
        expect(allowHeaders).toContain('authorization');
        expect(allowHeaders).toContain('connect-protocol-version');
        expect(allowHeaders).toContain('x-grpc-web');
        expect(allowHeaders).toContain('traceparent');
        expect(allowHeaders).toContain('tracestate');
      });

      it('grants nothing to another origin', async () => {
        const res = await preflight('https://evil.example');
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
      });

      it('exposes the protocol headers on the actual response', async () => {
        const res = await fetch(
          `${url(ports.publicPort)}/${HealthService.typeName}/Check`,
          {
            method: 'POST',
            headers: {
              origin: ALLOWED_ORIGIN,
              'content-type': 'application/json',
            },
            body: '{}',
          },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe(
          ALLOWED_ORIGIN,
        );
        expect(
          (
            res.headers.get('access-control-expose-headers') ?? ''
          ).toLowerCase(),
        ).toContain('grpc-status');
        expect(
          (
            res.headers.get('access-control-expose-headers') ?? ''
          ).toLowerCase(),
        ).toContain('trace-id');
      });
    });

    it('reports NOT_SERVING once it starts draining', async () => {
      const client = createClient(Health, grpc(ports.publicPort));
      const watch = client.watch({})[Symbol.asyncIterator]();
      expect((await watch.next()).value?.status).toBe(
        HealthCheckResponse_ServingStatus.SERVING,
      );
      const stopping = server.stop();
      expect((await watch.next()).value?.status).toBe(
        HealthCheckResponse_ServingStatus.NOT_SERVING,
      );
      await stopping;
    });
  });

  describe('without reflection', () => {
    beforeEach(() => start(false));

    it('does not serve the reflection service', async () => {
      const client = createClient(
        reflectionV1.ServerReflection,
        grpc(ports.publicPort),
      );
      async function* input() {
        yield {
          messageRequest: { case: 'listServices' as const, value: '' },
        };
      }
      await expectCode(
        (async () => {
          for await (const _ of client.serverReflectionInfo(input())) {
            // drain
          }
        })(),
        Code.Unimplemented,
      );
    });
  });
});
