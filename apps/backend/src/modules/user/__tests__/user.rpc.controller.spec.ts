import { Test, TestingModule } from '@nestjs/testing';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect';
import { toConnectError } from '../../../infrastructure/rpc/rpc-errors';
import { AppError } from '../../../common/errors';
import { UserRpcController } from '../controllers/user.rpc.controller';
import { UserService } from '../services/user.service';
import { UserSearchService } from '../services/user-search.service';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import {
  POLICY,
  type PolicyPort,
} from '../../../infrastructure/policy/policy.port';
import { RpcAuthzService } from '../../../infrastructure/rpc/rpc-authz.service';
import {
  rpcContextFor,
  withAuthorization,
  type RpcCalls,
} from '../../../infrastructure/rpc/testing/rpc-test-context';
import { TOKEN_VERIFIER } from '../../../common/auth/token-verifier.port';
import {
  credentialsFor,
  signAccessToken,
} from '../../auth/__tests__/token-fixtures';
import { UserRole, UserStatus } from '../schemas/user.schema';
import { IUserResponse } from '../interfaces/user.interface';
import {
  CreateUserRequestSchema,
  DeleteUserRequestSchema,
  EmptyRequestSchema,
  FindAllRequestSchema,
  FindByIdRequestSchema,
  FindSimilarRequestSchema,
  ReplaceUserRequestSchema,
  SearchUsersRequestSchema,
  UpdateUserRequestSchema,
} from '../../../gen/user/v1/user_pb';

const mockUser = (overrides = {}): IUserResponse => ({
  id: 'user-123',
  name: 'Alice',
  email: 'alice@example.com',
  status: UserStatus.ACTIVE,
  roles: [UserRole.EDITOR],
  loginCount: 3,
  ...overrides,
});

const validToken = signAccessToken({
  sub: 'user-123',
  email: 'alice@example.com',
  roles: [UserRole.EDITOR],
});
const viewerToken = signAccessToken({
  sub: 'user-456',
  email: 'bob@example.com',
  roles: [UserRole.VIEWER],
});
const adminToken = signAccessToken({
  sub: 'admin-1',
  email: 'root@example.com',
  roles: [UserRole.ADMIN],
});
const expiredToken = signAccessToken({ sub: 'user-123' }, { expiresIn: -1 });

const rpcCode = async (promise: Promise<unknown>): Promise<Code> => {
  try {
    await promise;
  } catch (err) {
    const mapped = toConnectError(err);
    expect(mapped).toBeInstanceOf(ConnectError);
    return mapped.code;
  }
  throw new Error('expected an error');
};

describe('UserRpcController', () => {
  let controller: RpcCalls<UserRpcController>;
  let authz: RpcAuthzService;
  let userService: Record<
    | 'create'
    | 'signUp'
    | 'findAll'
    | 'findById'
    | 'update'
    | 'delete'
    | 'search'
    | 'findSimilar',
    jest.Mock
  >;
  let opaService: jest.Mocked<PolicyPort>;

  const ctx = (token?: string): HandlerContext =>
    rpcContextFor(credentialsFor(token));

  beforeEach(async () => {
    userService = {
      create: jest.fn(),
      signUp: jest.fn(),
      findAll: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      search: jest.fn(),
      findSimilar: jest.fn(),
    };

    opaService = {
      allow: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<PolicyPort>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserRpcController,
        RpcAuthzService,
        AuthorizationService,
        { provide: UserService, useValue: userService },
        { provide: UserSearchService, useValue: userService },
        { provide: POLICY, useValue: opaService },
        { provide: TOKEN_VERIFIER, useValue: {} },
      ],
    }).compile();

    controller = withAuthorization(
      module.get(UserRpcController),
      module.get(AuthorizationService),
    );
    authz = module.get(RpcAuthzService);
  });

  // ── Create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    const request = (extra = {}) =>
      create(CreateUserRequestSchema, {
        name: 'Alice',
        email: 'alice@example.com',
        password: 'pass1234',
        ...extra,
      });

    // Reproduces the cross-tenant sign-up: an anonymous Create went straight
    // to UserService.create in whatever tenant X-Tenant-ID named.
    it('runs an anonymous create as self sign-up, admitted by the sign-up policy', async () => {
      userService.signUp.mockResolvedValue(mockUser());

      const res = await controller.create(
        request(),
        rpcContextFor({}, { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' }),
      );

      expect(res.id).toBe('user-123');
      expect(res.loginCount).toBe(3);
      expect(userService.create).not.toHaveBeenCalled();
      expect(userService.signUp).toHaveBeenCalledWith(
        {
          name: 'Alice',
          email: 'alice@example.com',
          password: 'pass1234',
          age: undefined,
          idempotencyKey: undefined,
        },
        '10.0.0.2',
      );
    });

    it('propagates a sign-up refusal', async () => {
      userService.signUp.mockRejectedValue(
        new AppError('TENANT_SIGNUP_CLOSED'),
      );
      expect(await rpcCode(controller.create(request(), ctx()))).toBe(
        Code.PermissionDenied,
      );
    });

    it('lets a caller holding user:create create without the sign-up policy', async () => {
      userService.create.mockResolvedValue(mockUser());

      await controller.create(
        request({ age: 30, idempotencyKey: 'key-1' }),
        ctx(adminToken),
      );

      expect(userService.signUp).not.toHaveBeenCalled();
      expect(userService.create).toHaveBeenCalledWith(
        expect.objectContaining({ age: 30, idempotencyKey: 'key-1' }),
        'user:admin-1',
      );
      expect(opaService.allow).toHaveBeenCalledWith(
        expect.objectContaining({ resource: 'user', action: 'create' }),
      );
    });

    it('treats a signed-in caller without user:create as self sign-up', async () => {
      opaService.allow.mockResolvedValue(false);
      userService.signUp.mockResolvedValue(mockUser());

      await controller.create(request(), ctx(viewerToken));

      expect(userService.create).not.toHaveBeenCalled();
      expect(userService.signUp).toHaveBeenCalled();
    });

    it('rejects an invalid token instead of treating it as anonymous', async () => {
      expect(
        await rpcCode(controller.create(request(), ctx(expiredToken))),
      ).toBe(Code.Unauthenticated);
      expect(userService.signUp).not.toHaveBeenCalled();
    });
  });

  // ── FindAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('returns paginated shape with defaults', async () => {
      userService.findAll.mockResolvedValue({
        data: [mockUser()],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const res = await controller.findAll(
        create(FindAllRequestSchema),
        ctx(validToken),
      );

      expect(res.users).toHaveLength(1);
      expect(res.total).toBe(1);
      expect(res.totalPages).toBe(1);
      expect(userService.findAll).toHaveBeenCalledWith(1, 20);
      expect(opaService.allow).toHaveBeenCalledWith(
        expect.objectContaining({ resource: 'user', action: 'list' }),
      );
    });

    it('passes through page and limit', async () => {
      userService.findAll.mockResolvedValue({
        data: [],
        total: 0,
        page: 2,
        limit: 5,
        totalPages: 0,
      });

      await controller.findAll(
        create(FindAllRequestSchema, { page: 2, limit: 5 }),
        ctx(validToken),
      );

      expect(userService.findAll).toHaveBeenCalledWith(2, 5);
    });
  });

  // ── FindById ─────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('maps user to the contract shape', async () => {
      userService.findById.mockResolvedValue(mockUser({ age: 30 }));

      const res = await controller.findById(
        create(FindByIdRequestSchema, { id: 'user-123' }),
        ctx(validToken),
      );

      expect(res.id).toBe('user-123');
      expect(res.age).toBe(30);
    });

    it("rejects a non-admin reading someone else's record", async () => {
      const code = await rpcCode(
        controller.findById(
          create(FindByIdRequestSchema, { id: 'user-123' }),
          ctx(viewerToken),
        ),
      );
      expect(code).toBe(Code.PermissionDenied);
      expect(userService.findById).not.toHaveBeenCalled();
    });
  });

  describe('read methods require authentication', () => {
    // Every read method returns user records, so one reachable without
    // credentials lets a caller dump every user's email.
    it.each([
      [
        'findAll',
        () => controller.findAll(create(FindAllRequestSchema), ctx()),
      ],
      [
        'findById',
        () =>
          controller.findById(
            create(FindByIdRequestSchema, { id: 'user-123' }),
            ctx(),
          ),
      ],
      [
        'search',
        () =>
          controller.search(
            create(SearchUsersRequestSchema, { query: 'a', size: 5 }),
            ctx(),
          ),
      ],
      [
        'findSimilar',
        () =>
          controller.findSimilar(
            create(FindSimilarRequestSchema, { userId: 'user-123' }),
            ctx(),
          ),
      ],
    ])('%s rejects an unauthenticated call', async (_name, call) => {
      expect(await rpcCode(call())).toBe(Code.Unauthenticated);
    });

    it('findAll clamps an oversized limit', async () => {
      userService.findAll.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 100,
        totalPages: 0,
      });
      await controller.findAll(
        create(FindAllRequestSchema, { page: 1, limit: 100000 }),
        ctx(validToken),
      );
      expect(userService.findAll).toHaveBeenCalledWith(1, 100);
    });
  });

  // ── GetMe ────────────────────────────────────────────────────────────────

  describe('getMe', () => {
    it('returns the caller from the authorization header', async () => {
      userService.findById.mockResolvedValue(mockUser());

      const res = await controller.getMe(
        create(EmptyRequestSchema),
        ctx(validToken),
      );

      expect(res.id).toBe('user-123');
      expect(userService.findById).toHaveBeenCalledWith('user-123');
    });

    it('rejects an expired token with UNAUTHENTICATED', async () => {
      const code = await rpcCode(
        controller.getMe(create(EmptyRequestSchema), ctx(expiredToken)),
      );
      expect(code).toBe(Code.Unauthenticated);
    });

    it('rejects an invalid token with UNAUTHENTICATED', async () => {
      const code = await rpcCode(
        controller.getMe(create(EmptyRequestSchema), ctx('not-a-token')),
      );
      expect(code).toBe(Code.Unauthenticated);
    });
  });

  // ── Update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    const req = (fields = {}) =>
      create(UpdateUserRequestSchema, { id: 'user-123', ...fields });

    it('rejects a call without a token', async () => {
      const code = await rpcCode(
        controller.update(req({ name: 'Bob' }), ctx()),
      );
      expect(code).toBe(Code.Unauthenticated);
    });

    it('rejects an invalid token', async () => {
      const code = await rpcCode(
        controller.update(req({ name: 'Bob' }), ctx('not-a-token')),
      );
      expect(code).toBe(Code.Unauthenticated);
    });

    it('passes only the set fields to UserService when OPA allows', async () => {
      userService.update.mockResolvedValue(mockUser({ name: 'Bob' }));

      const res = await controller.update(
        req({ name: 'Bob' }),
        ctx(validToken),
      );

      expect(opaService.allow).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'update' }),
      );
      const dto = userService.update.mock.calls[0][1];
      expect(dto).toEqual(expect.objectContaining({ name: 'Bob' }));
      expect(dto.email).toBeUndefined();
      expect(dto.status).toBeUndefined();
      expect(res.name).toBe('Bob');
    });

    it('rejects when OPA denies', async () => {
      opaService.allow.mockResolvedValue(false);

      const code = await rpcCode(
        controller.update(
          create(UpdateUserRequestSchema, { id: 'user-456', name: 'Bob' }),
          ctx(viewerToken),
        ),
      );
      expect(code).toBe(Code.PermissionDenied);
      expect(userService.update).not.toHaveBeenCalled();
    });

    it('lets only an admin write status', async () => {
      const code = await rpcCode(
        controller.update(req({ status: 'active' }), ctx(validToken)),
      );
      expect(code).toBe(Code.PermissionDenied);

      userService.update.mockResolvedValue(mockUser());
      await controller.update(req({ status: 'inactive' }), ctx(adminToken));
      expect(userService.update).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ status: 'inactive' }),
        { userId: 'admin-1', currentPassword: undefined },
      );
    });
  });

  // ── Replace ──────────────────────────────────────────────────────────────

  describe('replace', () => {
    const req = (status: string) =>
      create(ReplaceUserRequestSchema, {
        id: 'user-123',
        name: 'Alice',
        email: 'alice@example.com',
        status,
      });

    it('rejects an omitted (empty) status as INVALID_ARGUMENT', async () => {
      const code = await rpcCode(controller.replace(req(''), ctx(validToken)));
      expect(code).toBe(Code.InvalidArgument);
    });

    it('lets a non-admin restate the current status but not change it', async () => {
      userService.findById.mockResolvedValue(mockUser());
      userService.update.mockResolvedValue(mockUser());

      await controller.replace(req(UserStatus.ACTIVE), ctx(validToken));
      expect(userService.update).toHaveBeenCalled();

      const code = await rpcCode(
        controller.replace(req(UserStatus.INACTIVE), ctx(validToken)),
      );
      expect(code).toBe(Code.PermissionDenied);
    });
  });

  // ── Delete ───────────────────────────────────────────────────────────────

  describe('delete', () => {
    const req = create(DeleteUserRequestSchema, { id: 'user-123' });

    it('rejects a call without a token', async () => {
      expect(await rpcCode(controller.delete(req, ctx()))).toBe(
        Code.Unauthenticated,
      );
    });

    it('returns success when OPA allows', async () => {
      userService.delete.mockResolvedValue(undefined);

      const res = await controller.delete(req, ctx(validToken));

      expect(opaService.allow).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'delete' }),
      );
      expect(userService.delete).toHaveBeenCalledWith('user-123');
      expect(res.success).toBe(true);
    });

    it('rejects when OPA denies', async () => {
      opaService.allow.mockResolvedValue(false);

      expect(await rpcCode(controller.delete(req, ctx(viewerToken)))).toBe(
        Code.PermissionDenied,
      );
      expect(userService.delete).not.toHaveBeenCalled();
    });
  });

  // ── Search ───────────────────────────────────────────────────────────────

  describe('search', () => {
    it('returns a flat users page', async () => {
      userService.search.mockResolvedValue([
        mockUser(),
        mockUser({ id: 'user-456' }),
      ]);

      const res = await controller.search(
        create(SearchUsersRequestSchema, { query: 'alice', size: 10 }),
        ctx(validToken),
      );

      expect(res.users).toHaveLength(2);
      expect(res.total).toBe(2);
      expect(userService.search).toHaveBeenCalledWith('alice', 10);
    });
  });

  // ── FindSimilar ──────────────────────────────────────────────────────────

  describe('findSimilar', () => {
    it('returns similar users with the default limit', async () => {
      userService.findSimilar.mockResolvedValue([mockUser({ id: 'user-456' })]);

      const res = await controller.findSimilar(
        create(FindSimilarRequestSchema, { userId: 'user-123' }),
        ctx(validToken),
      );

      expect(res.users).toHaveLength(1);
      expect(userService.findSimilar).toHaveBeenCalledWith('user-123', 5);
    });
  });

  // ── AIP-158 pagination ───────────────────────────────────────────────────

  describe('page_size and page_token', () => {
    const page = (p: number, totalPages: number, total = 0) => ({
      data: [mockUser()],
      total,
      page: p,
      limit: 2,
      totalPages,
    });

    it('serves the first page and a token for the next one', async () => {
      userService.findAll.mockResolvedValue(page(1, 3, 5));

      const res = await controller.findAll(
        create(FindAllRequestSchema, { pageSize: 2 }),
        ctx(validToken),
      );

      expect(userService.findAll).toHaveBeenCalledWith(1, 2);
      expect(res.totalSize).toBe(5);
      expect(res.nextPageToken).not.toBe('');
    });

    it('follows the token to the next page and ends with an empty token', async () => {
      userService.findAll.mockResolvedValueOnce(page(1, 2, 3));
      const first = await controller.findAll(
        create(FindAllRequestSchema, { pageSize: 2 }),
        ctx(validToken),
      );
      userService.findAll.mockResolvedValueOnce(page(2, 2, 3));

      const second = await controller.findAll(
        create(FindAllRequestSchema, {
          pageSize: 2,
          pageToken: first.nextPageToken,
          page: 9,
          limit: 50,
        }),
        ctx(validToken),
      );

      expect(userService.findAll).toHaveBeenLastCalledWith(2, 2);
      expect(second.nextPageToken).toBe('');
    });

    it('rejects a page token it did not issue', async () => {
      expect(
        await rpcCode(
          controller.findAll(
            create(FindAllRequestSchema, { pageToken: 'forged' }),
            ctx(validToken),
          ),
        ),
      ).toBe(Code.InvalidArgument);
      expect(userService.findAll).not.toHaveBeenCalled();
    });

    it('prefers page_size over the deprecated size and limit', async () => {
      userService.search.mockResolvedValue([mockUser()]);
      userService.findSimilar.mockResolvedValue([mockUser()]);

      const found = await controller.search(
        create(SearchUsersRequestSchema, { query: 'a', size: 9, pageSize: 3 }),
        ctx(validToken),
      );
      await controller.findSimilar(
        create(FindSimilarRequestSchema, {
          userId: 'user-123',
          limit: 9,
          pageSize: 4,
        }),
        ctx(validToken),
      );

      expect(userService.search).toHaveBeenCalledWith('a', 3);
      expect(userService.findSimilar).toHaveBeenCalledWith('user-123', 4);
      expect(found.totalSize).toBe(1);
      expect(found.nextPageToken).toBe('');
    });
  });
});
