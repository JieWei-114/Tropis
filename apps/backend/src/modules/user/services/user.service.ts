import { Injectable, Inject, Optional } from '@nestjs/common';
import {
  CREDENTIAL_ATTEMPTS,
  type CredentialAttempts,
} from '../../../common/auth/credential-attempts.port';
import * as bcrypt from 'bcrypt';
import {
  decodeOffsetPageToken,
  encodeOffsetPageToken,
  resolvePageSize,
} from '@tropis/shared';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { AppError } from '../../../common/errors';
import { createLogger } from '../../../common/observability/logger';
import { isValidObjectId } from '../../../common/utils/object-id';
import type { TenantId } from '../../../common/keyspace';
import { KV, type KvPort } from '../../../infrastructure/kv/kv.port';
import { UserRole, UserStatus } from '../schemas/user.schema';
import { UserRepository } from '../repositories/user.repository';
import { UserTransformer } from '../transformers/user.transformer';
import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { ReplaceUserDto } from '../dto/replace-user.dto';
import {
  ACCOUNT_SUSPENDED_KEY,
  SUSPENDED_TTL_SECONDS,
  USER_ERROR_CODES,
} from '../constants/user.constants';
import {
  IUserResponse,
  IUserWithPassword,
  type UserRolesPage,
} from '../interfaces/user.interface';
import {
  CreateUserCommand,
  type ProviderIdentity,
} from '../commands/create-user.command';
import { UpdateUserCommand } from '../commands/update-user.command';
import { DeleteUserCommand } from '../commands/delete-user.command';
import { UpdateRolesCommand } from '../commands/update-roles.command';
import { GetUserQuery } from '../queries/get-user.query';
import { ListUsersQuery, type PagedUsers } from '../queries/list-users.query';
import { TenantContext } from '../../../common/tenant/tenant.context';
import { SignupPolicyService } from './signup-policy.service';

/** What the token verifier needs of a member: its live status, roles and token version. */
export interface MemberAccess {
  status: UserStatus;
  roles: UserRole[];
  tokenVersion: number;
}

/** Who asks for an update, for the current-password rule. */
export interface UpdateActor {
  userId: string;
  /** The caller's current password, required to change their own password or email. */
  currentPassword?: string;
  /** The caller's client address, for the login lockout. */
  ip?: string;
}

/** Profile of an account created on first sign-in with an OAuth provider. */
export interface ProviderSignup extends ProviderIdentity {
  name: string;
  email: string;
}

/** Rejects a malformed user id as not found, before it reaches a query. */
function assertUserId(id: string): void {
  if (!isValidObjectId(id)) throw new AppError(USER_ERROR_CODES.NOT_FOUND);
}

function assertPage(page: number, limit: number): void {
  const violations: { field: string; description: string }[] = [];
  if (!Number.isInteger(page) || page < 1) {
    violations.push({
      field: 'page',
      description: 'page must be a positive integer',
    });
  }
  if (!Number.isInteger(limit) || limit < 1) {
    violations.push({
      field: 'limit',
      description: 'limit must be a positive integer',
    });
  }
  if (violations.length) throw AppError.validation(violations);
}

@Injectable()
export class UserService {
  private readonly logger = createLogger('user');

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly userRepo: UserRepository,
    @Inject(KV) private readonly kv: KvPort,
    private readonly tenantCtx: TenantContext,
    private readonly signupPolicy: SignupPolicyService,
    // Absent in the worker role, which loads UserModule without AuthModule
    // and never runs a self-change.
    @Optional()
    @Inject(CREDENTIAL_ATTEMPTS)
    private readonly attempts?: CredentialAttempts,
  ) {}

  // ── Create ─────────────────────────────────────────────────────────
  /**
   * Unauthenticated self sign-up in the current tenant: admitted only when
   * the tenant is registered, active and open to self sign-up, and within the
   * per-address and per-tenant sign-up limits.
   */
  async signUp(dto: CreateUserDto, clientIp: string): Promise<IUserResponse> {
    await this.signupPolicy.assertAllowed(this.tenantCtx.tenant, clientIp);
    return this.create(dto, `ip:${clientIp}`);
  }

  /**
   * First sign-in with an OAuth provider: the same create command as
   * sign-up, so the account gets the default role and identity.user.created reaches
   * every projection. The tenant must accept self sign-up.
   */
  async signUpWithProvider(
    tenantId: TenantId,
    profile: ProviderSignup,
    clientIp: string,
  ): Promise<IUserWithPassword> {
    return this.tenantCtx.run(tenantId, async () => {
      await this.signupPolicy.assertAllowed(tenantId, clientIp);
      const created: IUserResponse = await this.commandBus.execute(
        new CreateUserCommand(
          profile.name,
          profile.email,
          '',
          undefined,
          undefined,
          { provider: profile.provider, providerId: profile.providerId },
        ),
      );
      const user = await this.userRepo.findById(tenantId, created.id);
      if (!user) throw new AppError(USER_ERROR_CODES.NOT_FOUND);
      return UserTransformer.toWithPassword(user);
    });
  }

  /**
   * Creates a user without the self sign-up checks (callers holding
   * `user:create`). `requester` scopes the idempotency key: `user:<id>` or
   * `ip:<address>`.
   */
  create(dto: CreateUserDto, requester: string): Promise<IUserResponse> {
    return this.commandBus.execute(
      new CreateUserCommand(
        dto.name,
        dto.email,
        dto.password,
        dto.age,
        dto.idempotencyKey,
        undefined,
        requester,
      ),
    );
  }

  // ── Read ───────────────────────────────────────────────────────────
  async findAll(page = 1, limit = 20): Promise<PagedUsers> {
    assertPage(page, limit);
    return this.queryBus.execute<ListUsersQuery, PagedUsers>(
      new ListUsersQuery(page, limit),
    );
  }

  // Used by gRPC — no pagination wrapper needed
  async findAllRaw(): Promise<IUserResponse[]> {
    const users = await this.userRepo.findAllRaw(this.tenantCtx.tenant);
    return UserTransformer.toResponseList(users);
  }

  async findById(id: string): Promise<IUserResponse> {
    assertUserId(id);
    return this.queryBus.execute(new GetUserQuery(id));
  }

  /**
   * Used only by the AuthService refresh flow, which knows the tenant from the
   * refresh token (the refresh call itself carries no access token).
   */
  async findByIdForAuth(
    tenantId: TenantId,
    id: string,
  ): Promise<IUserWithPassword | null> {
    const user = await this.userRepo.findById(tenantId, id);
    return user ? UserTransformer.toWithPassword(user) : null;
  }

  /** Includes passwordHash; for AuthService only, never cached. */
  async findByEmailWithPassword(
    tenantId: TenantId,
    email: string,
  ): Promise<IUserWithPassword | null> {
    const user = await this.userRepo.findByEmailWithPassword(tenantId, email);
    return user ? UserTransformer.toWithPassword(user) : null;
  }

  /**
   * Status, current roles and token version of a live member of the
   * tenant, or null when the user does not exist there (deleted, or another
   * tenant's id). Read from the store on every call, never from the profile
   * cache: the token verifier decides access with it, and a cache refill
   * racing a role or status change could serve the old values.
   */
  async findMember(
    tenantId: TenantId,
    userId: string,
  ): Promise<MemberAccess | null> {
    if (!isValidObjectId(userId)) return null;
    const access = await this.userRepo.findAccess(tenantId, userId);
    return access
      ? {
          status: access.status,
          roles: access.roles ?? [],
          tokenVersion: access.tokenVersion ?? 0,
        }
      : null;
  }

  async recordLogin(tenantId: TenantId, userId: string): Promise<void> {
    await this.userRepo.incrementLoginCount(tenantId, userId);
  }

  // ── Update ─────────────────────────────────────────────────────────
  // Accepts both PATCH (UpdateUserDto — partial) and PUT (ReplaceUserDto — full replacement).
  async update(
    id: string,
    dto: UpdateUserDto | ReplaceUserDto,
    actor?: UpdateActor,
  ): Promise<IUserResponse> {
    assertUserId(id);
    if (actor?.userId === id) await this.assertCurrentPassword(id, dto, actor);
    const response: IUserResponse = await this.commandBus.execute(
      new UpdateUserCommand(id, dto as UpdateUserCommand['patch']),
    );

    await this.syncSuspensionMarker(id, response.status);

    return response;
  }

  /**
   * A user changing their own password or email must give the current
   * password, so a stolen session cannot take the account over. An account
   * without a password (created through an OAuth provider) has none to give.
   */
  private async assertCurrentPassword(
    id: string,
    dto: UpdateUserDto | ReplaceUserDto,
    actor: UpdateActor,
  ): Promise<void> {
    const user = await this.userRepo.findByIdWithPassword(
      this.tenantCtx.tenant,
      id,
    );
    if (!user) throw new AppError(USER_ERROR_CODES.NOT_FOUND);
    const changesEmail =
      dto.email !== undefined && dto.email.toLowerCase() !== user.email;
    if (!dto.password && !changesEmail) return;
    if (!user.passwordHash) return;
    await this.verifyCurrentPassword(
      user.email,
      user.passwordHash,
      actor.currentPassword ?? '',
      actor.ip ?? 'unknown',
    );
  }

  /** The one place a self-change checks the current password. */
  private async verifyCurrentPassword(
    email: string,
    passwordHash: string,
    given: string,
    ip: string,
  ): Promise<void> {
    const tenant = this.tenantCtx.tenant;
    await this.attempts?.assertAllowed(tenant, email, ip);
    const matches = !!given && (await bcrypt.compare(given, passwordHash));
    if (!matches) {
      await this.attempts?.recordFailure(tenant, email, ip);
      throw new AppError('AUTH_CURRENT_PASSWORD_REQUIRED');
    }
  }

  /**
   * Keeps the account-suspended marker in step with the record, so a
   * suspension takes effect on tokens that were issued before it. Non-fatal:
   * a store failure must not fail the update, but it is logged because it
   * means the suspension is not enforced until the token expires.
   */
  private async syncSuspensionMarker(
    id: string,
    status: UserStatus,
  ): Promise<void> {
    const key = ACCOUNT_SUSPENDED_KEY.forTenant(this.tenantCtx.tenant, id);
    try {
      if (status === UserStatus.ACTIVE) {
        await this.kv.del(key);
      } else {
        await this.kv.set(key, status, { ttlSeconds: SUSPENDED_TTL_SECONDS });
      }
    } catch (err) {
      this.logger.warn(
        'suspension-marker-sync-failed',
        'Suspension marker sync failed',
        { 'user.id': id },
        err,
      );
    }
  }

  // ── Roles ──────────────────────────────────────────────────────────
  /** Current roles for every user, keyed by id — powers the Users page column. */
  async listRoles(pageSize?: number, pageToken = ''): Promise<UserRolesPage> {
    const limit = resolvePageSize(pageSize);
    const offset = decodeOffsetPageToken(pageToken);
    if (offset === undefined) {
      throw AppError.validation([
        { field: 'pageToken', description: 'pageToken is not valid' },
      ]);
    }
    const { data, total } = await this.userRepo.findRolesPage(
      this.tenantCtx.tenant,
      offset,
      limit,
    );
    const next = offset + data.length;
    return {
      items: data.map((u) => ({
        userId: u._id.toString(),
        roles: u.roles ?? [],
      })),
      nextPageToken:
        data.length > 0 && next < total ? encodeOffsetPageToken(next) : '',
      totalSize: total,
    };
  }

  /**
   * Replaces a user's roles (UpdateRolesCommand: outbox event, token
   * version bump, last-admin guard). Callers must check `manage_roles`.
   */
  async updateRoles(id: string, roles: UserRole[]): Promise<UserRole[]> {
    assertUserId(id);
    return this.commandBus.execute(new UpdateRolesCommand(id, roles));
  }

  // ── Delete ─────────────────────────────────────────────────────────
  async delete(id: string): Promise<void> {
    assertUserId(id);
    await this.commandBus.execute(new DeleteUserCommand(id));
  }

  /** A user by provider identity, with its password hash, for the OAuth sign-in. */
  async findByProvider(
    tenantId: TenantId,
    provider: string,
    providerId: string,
  ): Promise<IUserWithPassword | null> {
    const user = await this.userRepo.findByProvider(
      tenantId,
      provider,
      providerId,
    );
    return user ? UserTransformer.toWithPassword(user) : null;
  }
}
