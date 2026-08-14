import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserService } from '../services/user.service';
import { UserRepository } from '../repositories/user.repository';
import { SearchService } from '../../../infrastructure/elasticsearch/search.service';
import { UserVectorService } from '../../../infrastructure/postgres/user-vector.service';
import { VaultService } from '../../../infrastructure/vault/vault.service';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { PULSAR_CLIENT } from '../../../infrastructure/pulsar/pulsar.module';
import { CLICKHOUSE_CLIENT } from '../../../infrastructure/clickhouse/clickhouse.module';
import { UserRole, UserStatus } from '../schemas/user.schema';
import { IUserResponse } from '../interfaces/user.interface';

const mockUser = (overrides = {}): IUserResponse => ({
  id: 'user-123',
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
  let searchService: jest.Mocked<SearchService>;
  let vectorService: jest.Mocked<UserVectorService>;
  let eventEmitter: { emit: jest.Mock };
  let ch: { insert: jest.Mock };

  beforeEach(async () => {
    commandBus = { execute: jest.fn() } as unknown as jest.Mocked<CommandBus>;
    queryBus = { execute: jest.fn() } as unknown as jest.Mocked<QueryBus>;

    repo = {
      findAll: jest.fn(),
      findAllRaw: jest.fn(),
      findById: jest.fn(),
      findByEmail: jest.fn(),
      findByEmailWithPassword: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<UserRepository>;

    searchService = {
      ensureIndex: jest.fn().mockResolvedValue(undefined),
      index: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue({ hits: [], total: 0 }),
      bulkIndex: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SearchService>;

    vectorService = {
      upsertVector: jest.fn().mockResolvedValue(undefined),
      deleteVector: jest.fn().mockResolvedValue(undefined),
      findSimilar: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<UserVectorService>;

    ch = { insert: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: CommandBus, useValue: commandBus },
        { provide: QueryBus, useValue: queryBus },
        { provide: UserRepository, useValue: repo },
        { provide: SearchService, useValue: searchService },
        { provide: UserVectorService, useValue: vectorService },
        {
          provide: VaultService,
          useValue: {
            encrypt: jest.fn().mockResolvedValue(null),
            decrypt: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: EventEmitter2, useValue: eventEmitter },
        {
          provide: REDIS_CLIENT,
          useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
        },
        {
          provide: PULSAR_CLIENT,
          useValue: {
            createProducer: jest
              .fn()
              .mockResolvedValue({ send: jest.fn(), close: jest.fn() }),
          },
        },
        { provide: CLICKHOUSE_CLIENT, useValue: ch },
      ],
    }).compile();

    service = module.get(UserService);
    await service.onModuleInit().catch(() => {});
  });

  // ── create ─────────────────────────────────────────────────────────

  describe('create', () => {
    it('dispatches CreateUserCommand and returns response', async () => {
      const user = mockUser();
      commandBus.execute.mockResolvedValue(user);

      const result = await service.create({
        name: 'Alice',
        email: 'alice@example.com',
        password: 'secret',
      });

      expect(commandBus.execute).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'alice@example.com', name: 'Alice' }),
      );
      expect(result.email).toBe('alice@example.com');
      expect(result.roles).toEqual([UserRole.VIEWER]);
    });

    it('logs to ClickHouse after successful create', async () => {
      commandBus.execute.mockResolvedValue(mockUser());

      await service.create({
        name: 'Alice',
        email: 'alice@example.com',
        password: 'secret',
      });

      expect(ch.insert).toHaveBeenCalled();
    });
  });

  // ── findById ───────────────────────────────────────────────────────

  describe('findById', () => {
    it('dispatches GetUserQuery', async () => {
      queryBus.execute.mockResolvedValue(mockUser());

      const result = await service.findById('user-123');

      expect(queryBus.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-123' }),
      );
      expect(result.id).toBe('user-123');
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

      const result = await service.update('user-123', { name: 'Bob' });

      expect(commandBus.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-123' }),
      );
      expect(result.name).toBe('Bob');
    });

    it('logs to ClickHouse after successful update', async () => {
      commandBus.execute.mockResolvedValue(mockUser());

      await service.update('user-123', { name: 'Bob' });

      expect(ch.insert).toHaveBeenCalled();
    });
  });

  // ── delete ─────────────────────────────────────────────────────────

  describe('delete', () => {
    it('propagates NotFoundException from the command handler', async () => {
      commandBus.execute.mockRejectedValue(
        new NotFoundException('User missing not found'),
      );

      await expect(service.delete('missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(ch.insert).not.toHaveBeenCalled();
    });

    it('dispatches DeleteUserCommand and logs the returned email to ClickHouse', async () => {
      // DeleteUserCommand handler soft-deletes and returns the user's email
      commandBus.execute.mockResolvedValue('alice@example.com');

      await service.delete('user-123');

      expect(commandBus.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-123' }),
      );
      expect(ch.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          values: [expect.objectContaining({ email: 'alice@example.com' })],
        }),
      );
    });
  });
});
