import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { AppError, isAppError } from '../../../common/errors';
import {
  isTenantId,
  toTenantId,
  type TenantId,
} from '../../../common/keyspace';
import { KV, type KvPort } from '../../../infrastructure/kv/kv.port';
import { UserService } from '../../user/services/user.service';
import { UserStatus } from '../../user/constants/user.enums';
import type { IUserWithPassword } from '../../user/interfaces/user.interface';
import {
  OAUTH_SIGNIN_CODE_KEY,
  OAUTH_SIGNIN_CODE_TTL_SECONDS,
} from '../constants/auth.constants';
import { AuthService, type AuthTokens } from './auth.service';
import { OAuthUserProfile } from '../interfaces/oauth-profile.interface';
import type { SessionClient } from '../interfaces/session-client.interface';

interface SignInCode {
  tenantId: string;
  userId: string;
  /** base64url(SHA-256(verifier)) the browser that started the flow holds. */
  challenge: string;
  /** The session flow the code may be exchanged by; absent means web. */
  client?: SessionClient;
}

/** PKCE verifier: 43-128 base64url characters (RFC 7636). */
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** base64url of a SHA-256 digest. */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const codeKey = (code: string) =>
  OAUTH_SIGNIN_CODE_KEY.global(createHash('sha256').update(code).digest('hex'));

/**
 * The OAuth "find or create" flow, in the tenant named by OAUTH_TENANT_ID
 * (the provider redirect carries no tenant; without it the callback fails
 * with TENANT_REQUIRED). The tenant must be active.
 *
 *   - Match by (provider, providerId): the account this provider created.
 *   - Else, when any account holds the email (created with a password or
 *     another provider), refuse with OAUTH_ACCOUNT_EXISTS and leave it
 *     untouched: there is no email verification, so linking would hand the
 *     account to whoever registered the address first.
 *   - Else create the account through the same create-user command as
 *     sign-up (default role, user.created on the outbox), which requires the
 *     tenant to accept self sign-up.
 *
 * The callback never puts a token in a URL: it hands the browser a one-time
 * code (valid OAUTH_SIGNIN_CODE_TTL_SECONDS), bound to the PKCE challenge the
 * browser sent when it started the flow, that exchange() trades once for a
 * token pair given the matching verifier. A code is also bound to the flow
 * that started the sign-in: a native shell's code (returned to its custom
 * scheme) trades only through a native exchange, a web code only through a
 * web one.
 */
@Injectable()
export class OAuthService {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly config: ConfigService,
    @Inject(KV) private readonly kv: KvPort,
  ) {}

  /** The tenant OAuth sign-ins belong to (OAUTH_TENANT_ID). */
  tenant(): TenantId {
    const raw = this.config.get<string>('OAUTH_TENANT_ID');
    if (!raw) throw new AppError('TENANT_REQUIRED');
    if (!isTenantId(raw)) throw new AppError('TENANT_INVALID');
    return raw;
  }

  /** Finds or creates the account and returns a one-time sign-in code. */
  async signIn(
    profile: OAuthUserProfile,
    clientIp: string,
    challenge: string,
    tenantId: TenantId = this.tenant(),
    client: SessionClient = 'web',
  ): Promise<string> {
    if (!CHALLENGE_PATTERN.test(challenge)) {
      throw new AppError('OAUTH_STATE_INVALID');
    }
    const user = await this.findOrCreate(profile, clientIp, tenantId);
    const code = randomBytes(32).toString('base64url');
    const value: SignInCode = { tenantId, userId: user.id, challenge, client };
    await this.kv.set(codeKey(code), value, {
      ttlSeconds: OAUTH_SIGNIN_CODE_TTL_SECONDS,
    });
    return code;
  }

  /**
   * Trades a sign-in code, once, for an access + refresh token pair. The
   * code is spent by the first attempt, right or wrong, so its verifier
   * cannot be guessed.
   */
  async exchange(
    code: string,
    verifier: string,
    client: SessionClient = 'web',
  ): Promise<AuthTokens> {
    if (typeof code !== 'string' || !code) {
      throw new AppError('OAUTH_CODE_INVALID');
    }
    const key = codeKey(code);
    const stored = await this.kv.get<SignInCode>(key);
    if (!stored || !(await this.kv.del(key))) {
      throw new AppError('OAUTH_CODE_INVALID');
    }
    if (
      typeof verifier !== 'string' ||
      !VERIFIER_PATTERN.test(verifier) ||
      typeof stored.challenge !== 'string' ||
      !sameText(challengeOf(verifier), stored.challenge) ||
      (stored.client ?? 'web') !== client
    ) {
      throw new AppError('OAUTH_CODE_INVALID');
    }
    const tenantId = toTenantId(stored.tenantId);
    await this.authService.assertTenantActive(tenantId);
    const user = await this.userService.findByIdForAuth(
      tenantId,
      stored.userId,
    );
    if (!user) throw new AppError('OAUTH_CODE_INVALID');
    if (user.status !== UserStatus.ACTIVE) {
      throw new AppError('AUTH_ACCOUNT_INACTIVE');
    }
    return this.authService.issueTokenPair(user);
  }

  async findOrCreate(
    profile: OAuthUserProfile,
    clientIp: string,
    tenantId: TenantId,
  ): Promise<IUserWithPassword> {
    await this.authService.assertTenantActive(tenantId);

    const existing = await this.userService.findByProvider(
      tenantId,
      profile.provider,
      profile.providerId,
    );
    const account =
      existing ?? (await this.create(profile, clientIp, tenantId));

    if (account.status !== UserStatus.ACTIVE) {
      throw new AppError('AUTH_ACCOUNT_INACTIVE');
    }
    return account;
  }

  private async create(
    profile: OAuthUserProfile,
    clientIp: string,
    tenantId: TenantId,
  ): Promise<IUserWithPassword> {
    if (
      await this.userService.findByEmailWithPassword(tenantId, profile.email)
    ) {
      throw new AppError('OAUTH_ACCOUNT_EXISTS');
    }
    try {
      return await this.userService.signUpWithProvider(
        tenantId,
        {
          name: profile.name,
          email: profile.email,
          provider: profile.provider,
          providerId: profile.providerId,
        },
        clientIp,
      );
    } catch (err) {
      if (isAppError(err) && err.code === 'USER_ALREADY_EXISTS') {
        throw new AppError('OAUTH_ACCOUNT_EXISTS', { cause: err });
      }
      throw err;
    }
  }
}
