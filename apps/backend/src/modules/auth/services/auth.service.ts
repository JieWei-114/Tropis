import {
  Injectable,
  Logger,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomUUID, createHmac, createHash, timingSafeEqual } from 'crypto';
import type Redis from 'ioredis';
import { UserService } from '../../user/services/user.service';
import { LoginDto } from '../dto/login.dto';
import {
  UserDocument,
  DEFAULT_TENANT,
  UserStatus,
} from '../../user/schemas/user.schema';
import { IUserWithPassword } from '../../user/interfaces/user.interface';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { LoginLockoutService } from './login-lockout.service';
import { SessionService } from '../../../infrastructure/aerospike/session.service';

type TokenableUser = UserDocument | IUserWithPassword;

const BL_PREFIX = 'bl:'; // access-token blacklist  key = bl:{jti}
const RT_PREFIX = 'rt:'; // refresh token store      key = rt:{userId}:{tokenId}
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private readonly refreshSecret: string;

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly lockout: LoginLockoutService,
    private readonly sessions: SessionService,
  ) {
    this.refreshSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  /** Redis key stores a HASH of the tokenId, so a Redis read can't yield a
   *  usable refresh token (the client holds the raw tokenId + signature). */
  private refreshKey(userId: string, tokenId: string): string {
    const h = createHash('sha256').update(tokenId).digest('hex');
    return `${RT_PREFIX}${userId}:${h}`;
  }

  private signRefresh(userId: string, tokenId: string): string {
    return createHmac('sha256', this.refreshSecret)
      .update(`${userId}:${tokenId}`)
      .digest('hex');
  }

  async login(dto: LoginDto, ip = 'unknown'): Promise<AuthTokens> {
    // Lockout check FIRST — 5 failed attempts per email+IP within 15 min
    // rejects with 429 before any password work happens.
    await this.lockout.assertNotLocked(dto.email, ip);

    const user = await this.userService.findByEmailWithPassword(dto.email);

    if (!user) {
      await this.lockout.recordFailure(dto.email, ip);
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      await this.lockout.recordFailure(dto.email, ip);
      throw new UnauthorizedException('Invalid credentials');
    }

    // status is an access-control field: a suspended or inactive account must
    // not be able to obtain a token. Checked after the password so a wrong
    // password and a suspended account are indistinguishable to the caller.
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is not active');
    }

    await this.lockout.reset(dto.email, ip);
    // Fire-and-forget, but the rejection MUST be handled: an unhandled
    // rejection takes the whole process down on Node >= 15.
    this.userService
      .recordLogin(user.id, user.email)
      .catch((err: Error) =>
        this.logger.warn(`recordLogin failed: ${err.message}`),
      );

    // Fire-and-forget session record in Aerospike (no-op when client is null)
    void this.sessions.create(user.id, user.email, ip);

    return this.issueTokenPair(user);
  }

  /** Issue a fresh access + refresh token pair (used after OAuth and on token refresh). */
  async issueTokenPair(user: TokenableUser): Promise<AuthTokens> {
    const accessToken = this.signAccessToken(user);
    const refreshToken = await this.createRefreshToken(user);
    return { accessToken, refreshToken };
  }

  /** Backwards-compat: issue access token only (OAuth callback redirect flow). */
  issueToken(user: TokenableUser): string {
    return this.signAccessToken(user);
  }

  /**
   * Blacklist the current access token and delete the paired refresh token.
   * jti + exp come from the already-verified JWT payload in the request.
   */
  async logout(jti: string, exp: number, refreshToken?: string): Promise<void> {
    const ttlMs = exp * 1000 - Date.now();
    if (ttlMs > 0) {
      await this.redis.set(`${BL_PREFIX}${jti}`, '1', 'PX', ttlMs);
    }

    if (refreshToken) {
      const parsed = this.decodeRefreshToken(refreshToken);
      if (parsed) {
        await this.redis.del(this.refreshKey(parsed.userId, parsed.tokenId));
        // Fire-and-forget Aerospike session invalidation (no-op when client is null)
        void this.sessions.invalidate(parsed.userId);
      }
    }
  }

  /** Returns true when the access token's jti has been revoked. */
  async isBlacklisted(jti: string): Promise<boolean> {
    return (await this.redis.exists(`${BL_PREFIX}${jti}`)) === 1;
  }

  /**
   * Validate a refresh token, delete the old one (rotation), and return new tokens.
   * Throws UnauthorizedException if the token is invalid or expired.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const parsed = this.decodeRefreshToken(refreshToken);
    if (!parsed) throw new UnauthorizedException('Invalid refresh token');

    const key = this.refreshKey(parsed.userId, parsed.tokenId);
    const exists = await this.redis.exists(key);
    if (!exists)
      throw new UnauthorizedException('Refresh token expired or revoked');

    // Rotate — delete old token before issuing new pair
    await this.redis.del(key);

    const user = await this.userService.findByIdForAuth(parsed.userId);
    if (!user) throw new UnauthorizedException('User not found');

    // Refresh rotation — re-create the Aerospike session record (fire-and-forget)
    void this.sessions.create(parsed.userId, user.email);

    return this.issueTokenPair(user);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private signAccessToken(user: TokenableUser): string {
    const id = '_id' in user ? user._id.toString() : user.id;
    return this.jwtService.sign({
      sub: id,
      email: user.email,
      roles: user.roles ?? [],
      tenantId: user.tenantId ?? DEFAULT_TENANT,
      jti: randomUUID(),
    });
  }

  private async createRefreshToken(user: TokenableUser): Promise<string> {
    const userId = '_id' in user ? user._id.toString() : user.id;
    const tokenId = randomUUID();
    await this.redis.set(
      this.refreshKey(userId, tokenId),
      '1',
      'PX',
      REFRESH_TTL_MS,
    );
    const sig = this.signRefresh(userId, tokenId);
    return Buffer.from(JSON.stringify({ userId, tokenId, sig })).toString(
      'base64url',
    );
  }

  private decodeRefreshToken(
    token: string,
  ): { userId: string; tokenId: string } | null {
    try {
      const raw = Buffer.from(token, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const { userId, tokenId, sig } = parsed;
      if (
        typeof userId !== 'string' ||
        typeof tokenId !== 'string' ||
        typeof sig !== 'string'
      ) {
        return null;
      }
      // Verify HMAC integrity (constant-time) — a tampered/forged structure
      // is rejected before any Redis lookup.
      const expected = this.signRefresh(userId, tokenId);
      const a = Buffer.from(sig, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      return { userId, tokenId };
    } catch {
      return null;
    }
  }
}
