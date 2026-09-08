import { Test, TestingModule } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { GrpcUserService } from '../controllers/user.grpc.controller';
import { UserService } from '../services/user.service';
import { OpaService } from '../../../infrastructure/opa/opa.service';
import { GrpcAuthzService } from '../../../infrastructure/grpc/grpc-authz.service';
import { UserRole, UserStatus } from '../schemas/user.schema';
import { IUserResponse } from '../interfaces/user.interface';

const JWT_SECRET = 'test-secret';

const mockUser = (overrides = {}): IUserResponse => ({
  id: 'user-123',
  name: 'Alice',
  email: 'alice@example.com',
  status: UserStatus.ACTIVE,
  roles: [UserRole.EDITOR],
  loginCount: 3,
  ...overrides,
});

const validToken = jwt.sign(
  { sub: 'user-123', email: 'alice@example.com', roles: [UserRole.EDITOR] },
  JWT_SECRET,
);
const viewerToken = jwt.sign(
  { sub: 'user-456', email: 'bob@example.com', roles: [UserRole.VIEWER] },
  JWT_SECRET,
);
const expiredToken = jwt.sign({ sub: 'user-123' }, JWT_SECRET, {
  expiresIn: -1,
});

const authMeta = (token: string) => ({
  get: (k: string) => (k === 'authorization' ? [`Bearer ${token}`] : []),
});

const grpcCode = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
    throw new Error('expected RpcException');
  } catch (err) {
    expect(err).toBeInstanceOf(RpcException);
    return ((err as RpcException).getError() as { code: number }).code;
  }
};

describe('GrpcUserService', () => {
  let service: GrpcUserService;
  let userService: jest.Mocked<UserService>;
  let opaService: jest.Mocked<OpaService>;

  beforeEach(async () => {
    userService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      search: jest.fn(),
      findSimilar: jest.fn(),
    } as unknown as jest.Mocked<UserService>;

    opaService = {
      allow: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<OpaService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GrpcUserService,
        GrpcAuthzService,
        { provide: UserService, useValue: userService },
        { provide: OpaService, useValue: opaService },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => JWT_SECRET, get: () => '7d' },
        },
      ],
    }).compile();

    service = module.get(GrpcUserService);
  });

  // ── Create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('delegates to UserService and maps to gRPC shape', async () => {
      userService.create.mockResolvedValue(mockUser());

      const res = await service.create({
        name: 'Alice',
        email: 'alice@example.com',
        password: 'pass123',
      });

      expect(res.id).toBe('user-123');
      expect(res.name).toBe('Alice');
      expect(res.login_count).toBe(3);
      expect(userService.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'alice@example.com' }),
      );
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

      const res = await service.findAll({}, authMeta(validToken));

      expect(res.users).toHaveLength(1);
      expect(res.total).toBe(1);
      expect(res.total_pages).toBe(1);
      expect(userService.findAll).toHaveBeenCalledWith(1, 20);
    });

    it('passes through page and limit', async () => {
      userService.findAll.mockResolvedValue({
        data: [],
        total: 0,
        page: 2,
        limit: 5,
        totalPages: 0,
      });

      await service.findAll({ page: 2, limit: 5 }, authMeta(validToken));

      expect(userService.findAll).toHaveBeenCalledWith(2, 5);
    });
  });

  // ── FindById ─────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('maps user to gRPC shape', async () => {
      userService.findById.mockResolvedValue(mockUser({ age: 30 }));

      const res = await service.findById(
        { id: 'user-123' },
        authMeta(validToken),
      );

      expect(res.id).toBe('user-123');
      expect(res.age).toBe(30);
    });
  });

  // ── GetMe ────────────────────────────────────────────────────────────────

  describe('read methods require authentication', () => {
    // Every read method returns user records, so one reachable without
    // credentials lets a caller dump every user's email.
    it.each([
      ['findAll', () => service.findAll({}, undefined)],
      ['findById', () => service.findById({ id: 'user-123' }, undefined)],
      ['search', () => service.search({ query: 'a', size: 5 }, undefined)],
      [
        'findSimilar',
        () => service.findSimilar({ user_id: 'user-123' }, undefined),
      ],
    ])('%s rejects an unauthenticated call', async (_name, call) => {
      expect(await grpcCode(call())).toBe(GrpcStatus.UNAUTHENTICATED);
    });

    it('findAll clamps an oversized limit', async () => {
      userService.findAll.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 100,
        totalPages: 0,
      });
      await service.findAll({ page: 1, limit: 100000 }, authMeta(validToken));
      expect(userService.findAll).toHaveBeenCalledWith(1, 100);
    });
  });

  describe('getMe', () => {
    it('returns user for valid token', async () => {
      userService.findById.mockResolvedValue(mockUser());

      const res = await service.getMe({ token: validToken }, undefined);

      expect(res.id).toBe('user-123');
      expect(userService.findById).toHaveBeenCalledWith('user-123');
    });

    it('throws UNAUTHENTICATED RpcException for expired token', async () => {
      const code = await grpcCode(
        service.getMe({ token: expiredToken }, undefined),
      );
      expect(code).toBe(GrpcStatus.UNAUTHENTICATED);
    });

    it('throws UNAUTHENTICATED RpcException for invalid token', async () => {
      const code = await grpcCode(
        service.getMe({ token: 'not-a-token' }, undefined),
      );
      expect(code).toBe(GrpcStatus.UNAUTHENTICATED);
    });

    it('accepts the token from gRPC authorization metadata', async () => {
      userService.findById.mockResolvedValue(mockUser());

      const res = await service.getMe({}, authMeta(validToken));

      expect(res.id).toBe('user-123');
    });
  });

  // ── Update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('throws UNAUTHENTICATED RpcException when no token is provided', async () => {
      const code = await grpcCode(
        service.update({ id: 'user-123', name: 'Bob' }, undefined),
      );
      expect(code).toBe(GrpcStatus.UNAUTHENTICATED);
    });

    it('throws UNAUTHENTICATED RpcException for an invalid token', async () => {
      const code = await grpcCode(
        service.update(
          { id: 'user-123', name: 'Bob' },
          authMeta('not-a-token'),
        ),
      );
      expect(code).toBe(GrpcStatus.UNAUTHENTICATED);
    });

    it('passes partial fields to UserService when OPA allows', async () => {
      opaService.allow.mockResolvedValue(true);
      userService.update.mockResolvedValue(mockUser({ name: 'Bob' }));

      const res = await service.update(
        { id: 'user-123', name: 'Bob' },
        authMeta(validToken),
      );

      expect(opaService.allow).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'update' }),
      );
      expect(userService.update).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ name: 'Bob' }),
      );
      expect(res.name).toBe('Bob');
    });

    it('throws PERMISSION_DENIED RpcException when OPA denies', async () => {
      opaService.allow.mockResolvedValue(false);

      const code = await grpcCode(
        service.update({ id: 'user-123', name: 'Bob' }, authMeta(viewerToken)),
      );
      expect(code).toBe(GrpcStatus.PERMISSION_DENIED);
      expect(userService.update).not.toHaveBeenCalled();
    });
  });

  // ── Delete ───────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('throws UNAUTHENTICATED RpcException when no token is provided', async () => {
      const code = await grpcCode(
        service.delete({ id: 'user-123' }, undefined),
      );
      expect(code).toBe(GrpcStatus.UNAUTHENTICATED);
    });

    it('returns success true when OPA allows', async () => {
      opaService.allow.mockResolvedValue(true);
      userService.delete.mockResolvedValue(undefined);

      const res = await service.delete(
        { id: 'user-123' },
        authMeta(validToken),
      );

      expect(opaService.allow).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'delete' }),
      );
      expect(userService.delete).toHaveBeenCalledWith('user-123');
      expect(res.success).toBe(true);
    });

    it('throws PERMISSION_DENIED RpcException when OPA denies', async () => {
      opaService.allow.mockResolvedValue(false);

      const code = await grpcCode(
        service.delete({ id: 'user-123' }, authMeta(viewerToken)),
      );
      expect(code).toBe(GrpcStatus.PERMISSION_DENIED);
      expect(userService.delete).not.toHaveBeenCalled();
    });
  });

  // ── Search ───────────────────────────────────────────────────────────────

  describe('search', () => {
    it('returns flat users response', async () => {
      userService.search.mockResolvedValue([
        mockUser(),
        mockUser({ id: 'user-456' }),
      ]);

      const res = await service.search(
        { query: 'alice', size: 10 },
        authMeta(validToken),
      );

      expect(res.users).toHaveLength(2);
      expect(res.total).toBe(2);
      expect(userService.search).toHaveBeenCalledWith('alice', 10);
    });
  });

  // ── FindSimilar ──────────────────────────────────────────────────────────

  describe('findSimilar', () => {
    it('returns similar users with default limit', async () => {
      userService.findSimilar.mockResolvedValue([mockUser({ id: 'user-456' })]);

      const res = await service.findSimilar(
        { user_id: 'user-123' },
        authMeta(validToken),
      );

      expect(res.users).toHaveLength(1);
      expect(userService.findSimilar).toHaveBeenCalledWith('user-123', 5);
    });
  });
});
