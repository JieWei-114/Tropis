import { Injectable, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomUUID, createHmac, createHash, timingSafeEqual } from 'crypto';
import { AppError } from '../../../common/errors';
import { toTenantId, type TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import {
  TENANT_DIRECTORY,
  assertTenantActive,
  type TenantDirectory,
} from '../../../common/tenant/tenant-directory.port';
import { KV, type KvPort } from '../../../infrastructure/kv/kv.port';
import { UserService } from '../../user/services/user.service';
import { LoginDto } from '../dto/login.dto';
import { UserStatus } from '../../user/constants/user.enums';
import { IUserWithPassword } from '../../user/interfaces/user.interface';
import {
  REFRESH_TOKEN_KEY,
  REFRESH_TOKEN_TTL_SECONDS,
  TOKEN_REVOKED_KEY,
} from '../constants/auth.constants';
import { LoginLockoutService } from './login-lockout.service';
import { SessionService } from './session.service';

type TokenableUser = IUserWithPassword;

interface RefreshTokenClaims {
  tenantId: TenantId;
  userId: string;
  tokenId: string;
}

/** What the store keeps per live refresh token: the token version it was issued under. */
interface RefreshTokenRecord {
  tv: number;
}

function tokenVersionOf(user: TokenableUser): number {
  return user.tokenVersion ?? 0;
}

function storedVersion(value: unknown): number {
  const tv = (value as Partial<RefreshTokenRecord> | null)?.tv;
  return typeof tv === 'number' ? tv : 0;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = createLogger('auth');

  private readonly refreshSecret: string;

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    config: ConfigService,
    @Inject(KV) private readonly kv: KvPort,
    private readonly lockout: LoginLockoutService,
    private readonly sessions: SessionService,
    @Inject(TENANT_DIRECTORY) private readonly tenants: TenantDirectory,
  ) {
    this.refreshSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  /** The stored key holds a HASH of the tokenId, so a store read can't yield
   *  a usable refresh token (the client holds the raw tokenId + signature). */
  private refreshKey({ tenantId, userId, tokenId }: RefreshTokenClaims) {
    const h = createHash('sha256').update(tokenId).digest('hex');
    return REFRESH_TOKEN_KEY.forTenant(tenantId, userId, h);
  }

  /** HMAC over tenant, user and token id, so none can be swapped. */
  private signRefresh({ tenantId, userId, tokenId }: RefreshTokenClaims) {
    return createHmac('sha256', this.refreshSecret)
      .update(`${tenantId}\n${userId}\n${tokenId}`)
      .digest('hex');
  }

  /** Password login: an access + refresh token pair. */
  async login(
    tenantId: TenantId,
    dto: LoginDto,
    ip = 'unknown',
  ): Promise<AuthTokens> {
    return this.issueTokenPair(await this.authenticate(tenantId, dto, ip));
  }

  /** Password login for transports that hand out an access token only. */
  async loginAccessOnly(
    tenantId: TenantId,
    dto: LoginDto,
    ip = 'unknown',
  ): Promise<string> {
    return this.signAccessToken(await this.authenticate(tenantId, dto, ip));
  }

  /** Throws TENANT_NOT_FOUND or TENANT_INACTIVE unless the tenant is active. */
  async assertTenantActive(tenantId: TenantId): Promise<void> {
    assertTenantActive(await this.tenants.find(tenantId));
  }

  /**
   * The one credential check every login transport goes through: the tenant
   * must be active, then lockout (before any password work), then the
   * password, then the account status. Status is checked after the password so a wrong password and an
   * inactive account are indistinguishable to a guesser. An unregistered or
   * suspended tenant answers AUTH_INVALID_CREDENTIALS too, so an anonymous
   * caller cannot tell which tenant ids exist.
   */
  private async authenticate(
    tenantId: TenantId,
    dto: LoginDto,
    ip: string,
  ): Promise<IUserWithPassword> {
    if (!dto.email || !dto.password) {
      throw new AppError('AUTH_INVALID_CREDENTIALS');
    }
    const tenant = await this.tenants.find(tenantId);
    if (!tenant || tenant.status !== 'active') {
      throw new AppError('AUTH_INVALID_CREDENTIALS');
    }
    await this.lockout.assertNotLocked(tenantId, dto.email, ip);

    const user = await this.userService.findByEmailWithPassword(
      tenantId,
      dto.email,
    );
    const valid =
      !!user?.passwordHash &&
      (await bcrypt.compare(dto.password, user.passwordHash));
    if (!user || !valid) {
      await this.lockout.recordFailure(tenantId, dto.email, ip);
      throw new AppError('AUTH_INVALID_CREDENTIALS');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new AppError('AUTH_ACCOUNT_INACTIVE');
    }

    await this.lockout.reset(tenantId, dto.email, ip);
    this.userService
      .recordLogin(tenantId, user.id)
      .catch((err: unknown) =>
        this.logger.warn(
          'record-login-failed',
          'Recording the login failed',
          { 'user.id': user.id },
          err,
        ),
      );
    void this.sessions.create(tenantId, user.id, user.email, ip);
    return user;
  }

  /** Issue a fresh access + refresh token pair (used after OAuth and on token refresh). */
  async issueTokenPair(user: TokenableUser): Promise<AuthTokens> {
    const accessToken = this.signAccessToken(user);
    const refreshToken = await this.createRefreshToken(user);
    return { accessToken, refreshToken };
  }

  /**
   * Blacklist the current access token (when the caller still holds a valid
   * one) and delete the refresh token. jti + exp come from the verified JWT.
   */
  async logout(
    jti: string | undefined,
    exp: number | undefined,
    refreshToken?: string,
  ): Promise<void> {
    // Whole seconds, rounded up so the revocation never ends before the token.
    const ttlSeconds =
      exp === undefined ? 0 : Math.ceil((exp * 1000 - Date.now()) / 1000);
    if (jti && ttlSeconds > 0) {
      await this.kv.set(TOKEN_REVOKED_KEY.global(jti), true, { ttlSeconds });
    }

    if (refreshToken) {
      const parsed = this.decodeRefreshToken(refreshToken);
      if (parsed) {
        await this.kv.del(this.refreshKey(parsed));
        // Fire-and-forget session invalidation (SessionService logs its own failures)
        void this.sessions.invalidate(parsed.tenantId, parsed.userId);
      }
    }
  }

  /** Returns true when the access token's jti has been revoked. */
  async isBlacklisted(jti: string): Promise<boolean> {
    return this.kv.exists(TOKEN_REVOKED_KEY.global(jti));
  }

  /**
   * Validates a refresh token, deletes it (rotation) and returns a new pair,
   * in the refresh token's own tenant. An account that is no longer active,
   * or whose token version moved on since the token was issued, gets
   * nothing, so a suspension or a credential change ends the refresh chain.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const parsed = this.decodeRefreshToken(refreshToken);
    if (!parsed) throw new AppError('AUTH_TOKEN_INVALID');
    await this.assertTenantActive(parsed.tenantId);

    // Rotate — delete the old token before issuing a new pair. del() reports
    // whether it existed, so two concurrent refreshes cannot both succeed.
    const key = this.refreshKey(parsed);
    const record = await this.kv.get<RefreshTokenRecord | true>(key);
    const existed = await this.kv.del(key);
    if (!existed) throw new AppError('AUTH_TOKEN_REVOKED');

    const user = await this.userService.findByIdForAuth(
      parsed.tenantId,
      parsed.userId,
    );
    if (!user) throw new AppError('AUTH_TOKEN_INVALID');
    // A password, email, role or status change since this token was issued
    // ended its session.
    if (storedVersion(record) !== tokenVersionOf(user)) {
      throw new AppError('AUTH_TOKEN_REVOKED');
    }
    if (user.status !== UserStatus.ACTIVE) {
      void this.sessions.invalidate(parsed.tenantId, parsed.userId);
      throw new AppError('AUTH_ACCOUNT_INACTIVE');
    }

    // Refresh rotation — re-create the session record (fire-and-forget)
    void this.sessions.create(parsed.tenantId, parsed.userId, user.email);

    return this.issueTokenPair(user);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private signAccessToken(user: TokenableUser): string {
    const id = user.id;
    return this.jwtService.sign({
      sub: id,
      email: user.email,
      roles: user.roles ?? [],
      tenantId: tenantOf(user),
      jti: randomUUID(),
      tv: tokenVersionOf(user),
    });
  }

  private async createRefreshToken(user: TokenableUser): Promise<string> {
    const claims: RefreshTokenClaims = {
      tenantId: tenantOf(user),
      userId: user.id,
      tokenId: randomUUID(),
    };
    const record: RefreshTokenRecord = { tv: tokenVersionOf(user) };
    await this.kv.set(this.refreshKey(claims), record, {
      ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
    });
    const sig = this.signRefresh(claims);
    return Buffer.from(JSON.stringify({ ...claims, sig })).toString(
      'base64url',
    );
  }

  private decodeRefreshToken(token: string): RefreshTokenClaims | null {
    try {
      const raw = Buffer.from(token, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const { tenantId, userId, tokenId, sig } = parsed;
      if (
        typeof tenantId !== 'string' ||
        typeof userId !== 'string' ||
        typeof tokenId !== 'string' ||
        typeof sig !== 'string'
      ) {
        return null;
      }
      const claims: RefreshTokenClaims = {
        tenantId: toTenantId(tenantId),
        userId,
        tokenId,
      };
      // Verify HMAC integrity (constant-time) — a tampered/forged structure
      // is rejected before any store lookup.
      const expected = this.signRefresh(claims);
      const a = Buffer.from(sig, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      return claims;
    } catch {
      return null;
    }
  }
}

function tenantOf(user: TokenableUser): TenantId {
  return toTenantId(user.tenantId);
}
