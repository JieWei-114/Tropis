import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { UserRepository } from '../repositories/user.repository';
import { UserTransformer } from '../transformers/user.transformer';
import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { ReplaceUserDto } from '../dto/replace-user.dto';
import { USER_EVENTS } from '../constants/user.constants';
import { IUserResponse, IUserWithPassword } from '../interfaces/user.interface';
import { CLICKHOUSE_CLIENT } from '../../../infrastructure/clickhouse/clickhouse.module';
import { SearchService } from '../../../infrastructure/elasticsearch/search.service';
import { UserVectorService } from '../../../infrastructure/postgres/user-vector.service';
import { VaultService } from '../../../infrastructure/vault/vault.service';
import { CreateUserCommand } from '../commands/create-user.command';
import { UpdateUserCommand } from '../commands/update-user.command';
import { DeleteUserCommand } from '../commands/delete-user.command';
import { GetUserQuery } from '../queries/get-user.query';
import { ListUsersQuery } from '../queries/list-users.query';

const TRANSIT_KEY = 'user-data';

@Injectable()
export class UserService implements OnModuleInit {
  private readonly logger = new Logger(UserService.name);

  private readonly ES_INDEX = 'users';

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly userRepo: UserRepository,
    private readonly searchService: SearchService,
    private readonly vectorService: UserVectorService,
    private readonly vaultService: VaultService,
    @Inject(CLICKHOUSE_CLIENT) private readonly ch: ClickHouseClient,
  ) {}

  private async encryptEmail(email: string): Promise<string> {
    const cipher = await this.vaultService.encrypt(TRANSIT_KEY, email);
    if (!cipher) {
      this.logger.warn(
        'Vault unavailable — audit log will contain plaintext email (PII)',
      );
      return email;
    }
    return cipher;
  }

  private async decryptEmail(stored: string): Promise<string> {
    if (!stored.startsWith('vault:')) return stored; // not encrypted
    const plain = await this.vaultService.decrypt(TRANSIT_KEY, stored);
    return plain ?? stored;
  }

  async onModuleInit() {
    try {
      await this.searchService.ensureIndex(this.ES_INDEX, {
        properties: {
          id: { type: 'keyword' },
          name: { type: 'text', analyzer: 'standard' },
          email: { type: 'text', analyzer: 'standard' },
          status: { type: 'keyword' },
          age: { type: 'integer' },
        },
      });
    } catch (err) {
      this.logger.warn(
        `Elasticsearch index init failed — ${(err as Error).message}`,
      );
    }
  }

  // ── Create ─────────────────────────────────────────────────────────
  async create(dto: CreateUserDto): Promise<IUserResponse> {
    const response: IUserResponse = await this.commandBus.execute(
      new CreateUserCommand(
        dto.name,
        dto.email,
        dto.password,
        dto.age,
        dto.idempotencyKey,
      ),
    );

    // Pulsar publish for user.created is handled by the outbox relay — no direct publish here
    await this.logToClickHouse(
      USER_EVENTS.CREATED,
      response.id,
      response.email,
    );

    return response;
  }

  // ── Read ───────────────────────────────────────────────────────────
  async findAll(page = 1, limit = 20) {
    return this.queryBus.execute(new ListUsersQuery(page, limit));
  }

  // Used by gRPC — no pagination wrapper needed
  async findAllRaw(): Promise<IUserResponse[]> {
    const users = await this.userRepo.findAllRaw();
    return UserTransformer.toResponseList(users);
  }

  async findById(id: string): Promise<IUserResponse> {
    return this.queryBus.execute(new GetUserQuery(id));
  }

  // Used only by AuthService refresh flow — needs tenantId for token signing
  async findByIdForAuth(id: string): Promise<IUserWithPassword | null> {
    const user = await this.userRepo.findById(id);
    return user ? UserTransformer.toWithPassword(user) : null;
  }

  // Used only by AuthService — bypasses cache to get passwordHash
  async findByEmailWithPassword(
    email: string,
  ): Promise<IUserWithPassword | null> {
    const user = await this.userRepo.findByEmailWithPassword(email);
    return user ? UserTransformer.toWithPassword(user) : null;
  }

  // Called by AuthService after successful login — increments MongoDB counter directly.
  async recordLogin(userId: string, _email: string): Promise<void> {
    await this.userRepo.incrementLoginCount(userId);
  }

  // ── Update ─────────────────────────────────────────────────────────
  // Accepts both PATCH (UpdateUserDto — partial) and PUT (ReplaceUserDto — full replacement).
  async update(
    id: string,
    dto: UpdateUserDto | ReplaceUserDto,
  ): Promise<IUserResponse> {
    const response: IUserResponse = await this.commandBus.execute(
      new UpdateUserCommand(id, dto as any),
    );

    await this.logToClickHouse(USER_EVENTS.UPDATED, id, response.email);

    return response;
  }

  // ── Delete ─────────────────────────────────────────────────────────
  async delete(id: string): Promise<void> {
    // Handler fetches + soft-deletes in one query and returns the email — no double fetch
    const email: string = await this.commandBus.execute(
      new DeleteUserCommand(id),
    );

    await this.logToClickHouse(USER_EVENTS.DELETED, id, email);
  }

  async search(query: string, size = 10): Promise<IUserResponse[]> {
    const result = await this.searchService.search<IUserResponse>(
      this.ES_INDEX,
      {
        multi_match: {
          query,
          fields: ['name^2', 'email'],
          fuzziness: 'AUTO',
        },
      },
      { size },
    );
    return result.hits;
  }

  async findSimilar(userId: string, limit = 5): Promise<IUserResponse[]> {
    const similar = await this.vectorService.findSimilar(userId, limit);
    if (!similar.length) return [];
    const users = await Promise.all(
      similar.map((s) => this.findById(s.userId).catch(() => null)),
    );
    return users.filter(Boolean) as IUserResponse[];
  }

  private async logToClickHouse(
    eventType: string,
    userId: string,
    email: string,
  ): Promise<void> {
    try {
      // Encrypt PII (email) in the audit log — Vault Transit keeps the key off-disk
      const encryptedEmail = await this.encryptEmail(email);
      await this.ch.insert({
        table: 'logs.user_events',
        values: [
          {
            event_id: randomUUID(),
            event_type: eventType,
            user_id: userId,
            email: encryptedEmail,
            ts: Date.now(),
          },
        ],
        format: 'JSONEachRow',
      });
    } catch {
      /* ClickHouse may not be running locally */
    }
  }
}
