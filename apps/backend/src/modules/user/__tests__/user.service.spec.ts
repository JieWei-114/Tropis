import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { NotFoundException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserService } from '../services/user.service';
import { UserSearchService } from '../services/user-search.service';
import { AppError } from '../../../common/errors';
import { UserRepository } from '../repositories/user.repository';
import { toTenantId } from '../../../common/keyspace';
import { CACHE } from '../../../infrastructure/cache/cache.port';
import { KV } from '../../../infrastructure/kv/kv.port';
import { InMemoryKvAdapter } from '../../../infrastructure/kv/__tests__/in-memory-kv.adapter';
import { SEARCH } from '../../../infrastructure/search/search.port';
import {
  ACCOUNT_SUSPENDED_KEY,
  USER_PROFILE_CACHE,
} from '../constants/user.constants';
import { UserSimilarityService } from '../services/user-similarity.service';
import { UserRole, UserStatus } from '../schemas/user.schema';
import { IUserResponse } from '../interfaces/user.interface';
import { TenantContext } from '../../../common/tenant/tenant.context';
import { SignupPolicyService } from '../services/signup-policy.service';

const USER_ID = '64b7f0c2a1b2c3d4e5f60718';

const mockUser = (overrides = {}): IUserResponse => ({
  id: USER_ID,
  name: 'Alice',
  email: 'alice@example.com',
  status: UserStatus.ACTIVE,
  roles: [UserRole.VIEWER],
  loginCount: 0,
  ...overrides,
});

describe('UserService', () => {
  let service: UserService;
  let commandBus: jest.Mocked<CommandBus>;
  let queryBus: jest.Mocked<QueryBus>;
  let repo: jest.Mocked<UserRepository>;
  let search: {
    ensureIndex: jest.Mock;
    index: jest.Mock;
    remove: jest.Mock;
    query: jest.Mock;
  };
  let similarity: { findSimilar: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let searchService: UserSearchService;
  let kv: InMemoryKvAdapter;
  let cache: { del: jest.Mock; getOrLoad: jest.Mock };
  let signupPolicy: { assertAllowed: jest.Mock };
  const TENANT = toTenantId('acme');

  beforeEach(async () => {
    commandBus = { execute: jest.fn() } as unknown as jest.Mocked<CommandBus>;
    queryBus = { execute: jest.fn() } as unknown as jest.Mocked<QueryBus>;

    repo = {
      findAll: jest.fn(),
      findAllRaw: jest.fn(),
      findById: jest.fn(),
      findByEmail: jest.fn(),
      findByEmailWithPassword: jest.fn(),
      findByIdWithPassword: jest.fn(),
      findAccess: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<UserRepository>;

    search = {
      ensureIndex: jest.fn().mockResolvedValue(undefined),
      index: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ hits: [], total: 0 }),
    };

    similarity = { findSimilar: jest.fn().mockResolvedValue([]) };
    kv = new InMemoryKvAdapter();
    cache = {
      del: jest.fn().mockResolvedValue(undefined),
      getOrLoad: jest.fn((_k: unknown, _t: number, load: () => unknown) =>
        load(),
      ),
    };
    signupPolicy = { assertAllowed: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        UserSearchService,
        { provide: CommandBus, useValue: commandBus },
        { provide: QueryBus, useValue: queryBus },
        { provide: UserRepository, useValue: repo },
        { provide: SEARCH, useValue: search },
        { provide: UserSimilarityService, useValue: similarity },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: KV, useValue: kv },
        { provide: CACHE, useValue: cache },
        { provide: SignupPolicyService, useValue: signupPolicy },
        // UserService reads the ambient tenant for every repository call.
        {
          provide: TenantContext,
          useValue: {
            tenantId: TENANT,
            tenant: TENANT,
            run: (_t: string, fn: () => unknown) => fn(),
          },
        },
      ],
    }).compile();

    service = module.get(UserService);
    searchService = module.get(UserSearchService);
    await searchService.onModuleInit().catch(() => {});
  });

  // ── create ─────────────────────────────────────────────────────────

  describe('create', () => {
    it('dispatches CreateUserCommand and returns response', async () => {
      const user = mockUser();
      commandBus.execute.mockResolvedValue(user);

      const result = await service.create(
        {
          name: 'Alice',
          email: 'alice@example.com',
          password: 'secret',
        },
        'user:admin-1',
      );

      expect(commandBus.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'alice@example.com',
          name: 'Alice',
          requester: 'user:admin-1',
        }),
      );
      expect(result.email).toBe('alice@example.com');
      expect(result.roles).toEqual([UserRole.VIEWER]);
    });
  });

  // ── signUp ─────────────────────────────────────────────────────────
  describe('signUp', () => {
    const dto = { name: 'A', email: 'a@example.com', password: 'password1' };

    it('admits the sign-up through the policy, then creates the user', async () => {
      commandBus.execute.mockResolvedValue(mockUser());
      await service.signUp(dto, '203.0.113.9');
      expect(signupPolicy.assertAllowed).toHaveBeenCalledWith(
        TENANT,
        '203.0.113.9',
      );
      expect(commandBus.execute).toHaveBeenCalledTimes(1);
    });

    it('creates nothing when the policy refuses', async () => {
      signupPolicy.assertAllowed.mockRejectedValue(
        new AppError('TENANT_SIGNUP_CLOSED'),
      );
      await expect(service.signUp(dto, 'ip')).rejects.toMatchObject({
        code: 'TENANT_SIGNUP_CLOSED',
      });
      expect(commandBus.execute).not.toHaveBeenCalled();
    });
  });

  // ── malformed input ────────────────────────────────────────────────
  // Reproduces the gap: a malformed id reached Mongoose, whose CastError
  // surfaced as INTERNAL, and a negative page became a negative skip.
  describe('malformed input', () => {
    it.each([
      ['findById', (s: UserService) => s.findById('not-an-id')],
      ['update', (s: UserService) => s.update('not-an-id', { name: 'x' })],
      ['delete', (s: UserService) => s.delete('not-an-id')],
      [
        'updateRoles',
        (s: UserService) => s.updateRoles('not-an-id', [UserRole.ADMIN]),
      ],
    ])('%s answers USER_NOT_FOUND for a malformed id', async (_n, call) => {
      await expect(call(service)).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
      });
      expect(commandBus.execute).not.toHaveBeenCalled();
      expect(queryBus.execute).not.toHaveBeenCalled();
    });

    it.each([
      [0, 20],
      [-1, 20],
      [1.5, 20],
      [1, 0],
    ])('findAll(%p, %p) answers VALIDATION_FAILED', async (page, limit) => {
      await expect(service.findAll(page, limit)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      expect(queryBus.execute).not.toHaveBeenCalled();
    });
  });

  // ── findMember ─────────────────────────────────────────────────────
  describe('findMember', () => {
    it("returns the member's live status, roles and token version", async () => {
      repo.findAccess.mockResolvedValue({
        status: UserStatus.ACTIVE,
        roles: [UserRole.MEMBER],
        tokenVersion: 2,
      } as never);
      await expect(service.findMember(TENANT, USER_ID)).resolves.toEqual({
        status: UserStatus.ACTIVE,
        roles: [UserRole.MEMBER],
        tokenVersion: 2,
      });
    });

    // Reproduces the race: the verifier read roles through the profile
    // cache, and a refill that started before a demotion wrote the old
    // roles back after the change deleted them, for the cache TTL.
    it('reads access fields from the store, never the profile cache', async () => {
      repo.findAccess.mockResolvedValue({
        status: UserStatus.ACTIVE,
        roles: [UserRole.MEMBER],
        tokenVersion: 0,
      } as never);
      await service.findMember(TENANT, USER_ID);
      expect(cache.getOrLoad).not.toHaveBeenCalled();
      expect(repo.findAccess).toHaveBeenCalledWith(TENANT, USER_ID);
    });

    it('returns null for a malformed id without a query', async () => {
      await expect(service.findMember(TENANT, 'nope')).resolves.toBeNull();
      expect(repo.findAccess).not.toHaveBeenCalled();
    });
  });

  // ── findById ───────────────────────────────────────────────────────

  describe('findById', () => {
    it('dispatches GetUserQuery', async () => {
      queryBus.execute.mockResolvedValue(mockUser());

      const result = await service.findById(USER_ID);

      expect(queryBus.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: USER_ID }),
      );
      expect(result.id).toBe(USER_ID);
    });
  });

  // ── findAll ────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('dispatches ListUsersQuery with page + limit', async () => {
      const paginated = {
        data: [mockUser()],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      };
      queryBus.execute.mockResolvedValue(paginated);

      const result = await service.findAll(1, 20);

      expect(queryBus.execute).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 20 }),
      );
      expect(result.total).toBe(1);
    });
  });

  // ── update ─────────────────────────────────────────────────────────

  describe('update', () => {
    it('dispatches UpdateUserCommand and returns updated user', async () => {
      commandBus.execute.mockResolvedValue(mockUser({ name: 'Bob' }));

      const result = await service.update(USER_ID, { name: 'Bob' });

      expect(commandBus.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: USER_ID }),
      );
      expect(result.name).toBe('Bob');
    });
  });

  // ── delete ─────────────────────────────────────────────────────────

  describe('delete', () => {
    it('propagates NotFoundException from the command handler', async () => {
      commandBus.execute.mockRejectedValue(
        new NotFoundException('User missing not found'),
      );

      await expect(service.delete('64b7f0c2a1b2c3d4e5f60719')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('dispatches DeleteUserCommand', async () => {
      // DeleteUserCommand handler soft-deletes and returns the user's email
      commandBus.execute.mockResolvedValue('alice@example.com');

      await service.delete(USER_ID);

      expect(commandBus.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: USER_ID }),
      );
    });
  });

  // ── suspension marker ──────────────────────────────────────────────

  describe('suspension marker', () => {
    const marker = ACCOUNT_SUSPENDED_KEY.forTenant(TENANT, USER_ID);

    it('sets the tenant-scoped marker when an update leaves the account inactive', async () => {
      commandBus.execute.mockResolvedValue(
        mockUser({ status: UserStatus.INACTIVE }),
      );
      await service.update(USER_ID, { status: UserStatus.INACTIVE });
      await expect(kv.exists(marker)).resolves.toBe(true);
    });

    it('clears the marker when the account is active again', async () => {
      await kv.set(marker, 'inactive', { ttlSeconds: 60 });
      commandBus.execute.mockResolvedValue(mockUser());
      await service.update(USER_ID, { status: UserStatus.ACTIVE });
      await expect(kv.exists(marker)).resolves.toBe(false);
    });
  });

  // ── roles ──────────────────────────────────────────────────────────

  describe('updateRoles', () => {
    it('dispatches UpdateRolesCommand', async () => {
      commandBus.execute.mockResolvedValue([UserRole.ADMIN]);
      await expect(
        service.updateRoles(USER_ID, [UserRole.ADMIN]),
      ).resolves.toEqual([UserRole.ADMIN]);
      expect(commandBus.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: USER_ID, roles: [UserRole.ADMIN] }),
      );
    });
  });

  // ── current password ───────────────────────────────────────────────

  describe('self password or email change', () => {
    const withHash = async (password: string) => ({
      _id: USER_ID,
      email: 'alice@example.com',
      passwordHash: await bcrypt.hash(password, 4),
    });

    // Reproduces the gap: a stolen session could change the account's
    // password or email without knowing the current password.
    it.each([
      ['password', { password: 'new-password-1' }],
      ['email', { email: 'mallory@example.com' }],
    ])(
      'requires the current password to change the %s',
      async (_label, dto) => {
        repo.findByIdWithPassword.mockResolvedValue(
          (await withHash('old-password-1')) as never,
        );
        await expect(
          service.update(USER_ID, dto, { userId: USER_ID }),
        ).rejects.toMatchObject({ code: 'AUTH_CURRENT_PASSWORD_REQUIRED' });
        await expect(
          service.update(USER_ID, dto, {
            userId: USER_ID,
            currentPassword: 'wrong-password',
          }),
        ).rejects.toMatchObject({ code: 'AUTH_CURRENT_PASSWORD_REQUIRED' });
        expect(commandBus.execute).not.toHaveBeenCalled();
      },
    );

    it('accepts the change with the correct current password', async () => {
      repo.findByIdWithPassword.mockResolvedValue(
        (await withHash('old-password-1')) as never,
      );
      commandBus.execute.mockResolvedValue(mockUser());
      await service.update(
        USER_ID,
        { password: 'new-password-1' },
        { userId: USER_ID, currentPassword: 'old-password-1' },
      );
      expect(commandBus.execute).toHaveBeenCalled();
    });

    it('does not ask for it on a profile-only change', async () => {
      repo.findByIdWithPassword.mockResolvedValue(
        (await withHash('old-password-1')) as never,
      );
      commandBus.execute.mockResolvedValue(mockUser());
      await service.update(USER_ID, { name: 'Al' }, { userId: USER_ID });
      expect(commandBus.execute).toHaveBeenCalled();
    });

    it('lets an admin reset another user without it', async () => {
      commandBus.execute.mockResolvedValue(mockUser());
      await service.update(
        USER_ID,
        { password: 'new-password-1' },
        { userId: 'admin-1' },
      );
      expect(repo.findByIdWithPassword).not.toHaveBeenCalled();
      expect(commandBus.execute).toHaveBeenCalled();
    });
  });

  // ── search / similarity ────────────────────────────────────────────

  describe('search', () => {
    it("queries the current tenant's documents only", async () => {
      search.query.mockResolvedValue({ hits: [mockUser()], total: 1 });

      const hits = await searchService.search('ali', 5);

      expect(search.query).toHaveBeenCalledWith(TENANT, 'users', 'ali', {
        fields: ['name^2', 'email'],
        fuzzy: true,
        size: 5,
      });
      expect(hits).toHaveLength(1);
    });
  });

  describe('findSimilar', () => {
    it('asks for neighbours in the current tenant and loads them in one query', async () => {
      similarity.findSimilar.mockResolvedValue([
        { userId: 'b', distance: 0.1 },
        { userId: 'a', distance: 0.2 },
      ]);
      repo.findByIds = jest.fn().mockResolvedValue([
        { _id: 'a', name: 'A', email: 'a@x', status: 'active', roles: [] },
        { _id: 'b', name: 'B', email: 'b@x', status: 'active', roles: [] },
      ]);

      const users = await searchService.findSimilar(USER_ID, 2);

      expect(similarity.findSimilar).toHaveBeenCalledWith(TENANT, USER_ID, 2);
      expect(users.map((u) => u.id)).toEqual(['b', 'a']);
    });
  });
});
