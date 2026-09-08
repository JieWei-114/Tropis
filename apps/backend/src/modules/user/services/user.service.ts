import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  OnModuleInit,
  ConflictException,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { UserRole, UserStatus } from '../schemas/user.schema';
import { UserRepository } from '../repositories/user.repository';
import { UserTransformer } from '../transformers/user.transformer';
import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { ReplaceUserDto } from '../dto/replace-user.dto';
import {
  USER_ERROR_CODES,
  USER_EVENTS,
  suspendedKey,
  SUSPENDED_TTL_SECONDS,
} from '../constants/user.constants';
import { IUserResponse, IUserWithPassword } from '../interfaces/user.interface';
import type Redis from 'ioredis';
import { CLICKHOUSE_CLIENT } from '../../../infrastructure/clickhouse/clickhouse.module';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { SearchService } from '../../../infrastructure/elasticsearch/search.service';
import { UserVectorService } from '../../../infrastructure/postgres/user-vector.service';
import { VaultService } from '../../../infrastructure/vault/vault.service';
import { CreateUserCommand } from '../commands/create-user.command';
import { UpdateUserCommand } from '../commands/update-user.command';
import { DeleteUserCommand } from '../commands/delete-user.command';
import { GetUserQuery } from '../queries/get-user.query';
import { ListUsersQuery } from '../queries/list-users.query';
import { TenantContext } from '../../../common/tenant/tenant.context';

const TRANSIT_KEY = 'user-data';
/**
 * Written to the audit log in place of an email when Vault cannot encrypt it.
 * Distinguishable from a real value and from ciphertext, so a reader can tell
 * "we chose not to store this" from "this is encrypted".
 */
const REDACTED_EMAIL = '[redacted]';

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
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly tenantCtx: TenantContext,
  ) {}

  /**
   * Encrypts an email for the audit log, or REDACTS it if that is impossible.
   *
   * Never falls back to the plaintext address: Vault is absent whenever
   * VAULT_ADDR/VAULT_TOKEN are unset — the state of any fresh checkout before
   * vault-init is run — and that path would fill logs.user_events with
   * unencrypted PII. Degrading to plaintext is the one outcome an encryption
   * step must not have. The row's value is the event and the user id, and the
   * address is always recoverable from the users collection, so redacting
   * loses nothing and leaks nothing.
   */
  private async encryptEmail(email: string): Promise<string> {
    const cipher = await this.vaultService.encrypt(TRANSIT_KEY, email);
    if (!cipher) {
      this.logger.warn(
        'Vault unavailable — email redacted in the audit log rather than stored as plaintext PII',
      );
      return REDACTED_EMAIL;
    }
    return cipher;
  }

  /**
   * Read counterpart of encryptEmail. No caller today — nothing reads
   * logs.user_events — but it is what any consumer of that column must use,
   * and it is deliberately tolerant of both markers.
   */
  private async decryptEmail(stored: string): Promise<string> {
    if (stored === REDACTED_EMAIL) return stored;
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
    const users = await this.userRepo.findAllRaw(this.tenantCtx.tenantId);
    return UserTransformer.toResponseList(users);
  }

  async findById(id: string): Promise<IUserResponse> {
    return this.queryBus.execute(new GetUserQuery(id));
  }

  // Used only by AuthService refresh flow — needs tenantId for token signing
  async findByIdForAuth(id: string): Promise<IUserWithPassword | null> {
    const user = await this.userRepo.findById(id, this.tenantCtx.tenantId);
    return user ? UserTransformer.toWithPassword(user) : null;
  }

  // Used only by AuthService — bypasses cache to get passwordHash
  async findByEmailWithPassword(
    email: string,
  ): Promise<IUserWithPassword | null> {
    const user = await this.userRepo.findByEmailWithPassword(
      email,
      this.tenantCtx.tenantId,
    );
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
    await this.syncSuspensionMarker(id, response.status);

    return response;
  }

  /**
   * Keeps the `susp:<id>` marker in step with the record, so a suspension takes
   * effect on tokens that were issued before it. Non-fatal: a Redis failure
   * must not fail the update, but it is logged because it means the suspension
   * is not enforced until the token expires.
   */
  private async syncSuspensionMarker(
    id: string,
    status: UserStatus,
  ): Promise<void> {
    const key = suspendedKey(id);
    try {
      if (status === UserStatus.ACTIVE) {
        await this.redis.del(key);
      } else {
        await this.redis.set(key, status, 'EX', SUSPENDED_TTL_SECONDS);
      }
    } catch (err) {
      this.logger.warn(
        `Suspension marker sync failed for ${id}: ${(err as Error).message}`,
      );
    }
  }

  // ── Roles ──────────────────────────────────────────────────────────
  /** Current roles for every user, keyed by id — powers the Users page column. */
  async listRoles(): Promise<Record<string, UserRole[]>> {
    const users = await this.userRepo.findAllRaw(this.tenantCtx.tenantId);
    const map: Record<string, UserRole[]> = {};
    for (const u of users) {
      map[u._id.toString()] = u.roles ?? [];
    }
    return map;
  }

  /** Replaces a user's roles. Callers must check the `manage_roles` permission. */
  async updateRoles(id: string, roles: UserRole[]): Promise<UserRole[]> {
    // Refuse to remove the last admin: `manage_roles` is admin-only, so
    // demoting the final one locks the tenant out of role management entirely
    // and can only be undone with database access (make promote-admin).
    if (!roles.includes(UserRole.ADMIN)) {
      const all = await this.userRepo.findAllRaw(this.tenantCtx.tenantId);
      const admins = all.filter((u) =>
        (u.roles ?? []).includes(UserRole.ADMIN),
      );
      if (admins.length <= 1 && admins.some((u) => u._id.toString() === id)) {
        throw new ConflictException({
          code: USER_ERROR_CODES.LAST_ADMIN,
          message: 'Cannot remove the last admin of this tenant',
        });
      }
    }
    const updated = await this.userRepo.update(
      id,
      { roles },
      this.tenantCtx.tenantId,
    );
    if (!updated) {
      throw new NotFoundException({
        code: USER_ERROR_CODES.NOT_FOUND,
        message: 'User not found',
      });
    }
    // Bust the read cache: GetUserHandler caches `user:<id>` for 300s, so a
    // demotion would otherwise keep reporting the stale role for minutes.
    await this.redis
      .del(`user:${id}`)
      .catch((err: Error) =>
        this.logger.warn(`Role cache invalidation failed: ${err.message}`),
      );
    return updated.roles ?? [];
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
    // One query for all of them. A per-row findById is an N+1 that, with an
    // unclamped limit, fires thousands of concurrent queries and can exhaust
    // the connection pool from a single RPC.
    const found = await this.userRepo.findByIds(
      similar.map((s) => s.userId),
      this.tenantCtx.tenantId,
    );
    const byId = new Map(found.map((u) => [u._id.toString(), u]));
    // Preserve the distance ordering returned by pgvector.
    return similar
      .map((s) => byId.get(s.userId))
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((u) => UserTransformer.toResponse(u));
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
            tenant_id: this.tenantCtx.tenantId,
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
