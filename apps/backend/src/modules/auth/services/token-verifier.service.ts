import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { AppError, isAppError } from '../../../common/errors';
import { isTenantId, type TenantId } from '../../../common/keyspace';
import type {
  Principal,
  TokenVerifier,
} from '../../../common/auth/token-verifier.port';
import {
  TENANT_DIRECTORY,
  type TenantDirectory,
} from '../../../common/tenant/tenant-directory.port';
import { KV, type KvPort } from '../../../infrastructure/kv/kv.port';
import { UserService } from '../../user/services/user.service';
import { UserStatus } from '../../user/constants/user.enums';
import { ACCOUNT_SUSPENDED_KEY } from '../../user/constants/user.constants';
import { TOKEN_REVOKED_KEY } from '../constants/auth.constants';

export type MemberLookup = Pick<UserService, 'findMember'>;
export type TenantLookup = Pick<TenantDirectory, 'find'>;

interface AccessTokenClaims {
  sub?: unknown;
  email?: unknown;
  tenantId?: unknown;
  jti?: unknown;
  exp?: unknown;
  tv?: unknown;
}

const nonEmpty = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

/**
 * TokenVerifier over HS256 access tokens. The principal's roles come from
 * the member record, never from the token, so a demotion applies to tokens
 * issued before it; the token's version (`tv`, 0 when absent) must equal the
 * member's tokenVersion, so a password, email, role or status change ends
 * every earlier session; the tenant must still be registered and active. Every
 * store failure fails closed with SERVICE_UNAVAILABLE: an unreachable
 * revocation, membership or tenant store must not let a revoked token, a
 * suspended account or a suspended tenant through.
 */
@Injectable()
export class TokenVerifierService implements TokenVerifier {
  private readonly secret: string;

  constructor(
    config: ConfigService,
    @Inject(KV) private readonly kv: KvPort,
    @Inject(UserService) private readonly members: MemberLookup,
    @Inject(TENANT_DIRECTORY) private readonly tenants: TenantLookup,
  ) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
  }

  async verify(token: string): Promise<Principal> {
    const claims = this.decode(token);
    const tenantId: TenantId = claims.tenantId;

    const [revoked, suspended, member, tenant] = await this.guardStores(() =>
      Promise.all([
        this.kv.exists(TOKEN_REVOKED_KEY.global(claims.jti)),
        this.kv.exists(ACCOUNT_SUSPENDED_KEY.forTenant(tenantId, claims.sub)),
        this.members.findMember(tenantId, claims.sub),
        this.tenants.find(tenantId),
      ]),
    );
    if (revoked) throw new AppError('AUTH_TOKEN_REVOKED');
    if (member === null || tenant === null) {
      throw new AppError('AUTH_TOKEN_INVALID');
    }
    if (claims.tokenVersion !== (member.tokenVersion ?? 0)) {
      throw new AppError('AUTH_TOKEN_REVOKED');
    }
    if (tenant.status !== 'active') throw new AppError('TENANT_INACTIVE');
    if (suspended || member.status !== UserStatus.ACTIVE) {
      throw new AppError('AUTH_ACCOUNT_INACTIVE');
    }

    return {
      userId: claims.sub,
      email: claims.email,
      roles: [...member.roles],
      tenantId,
      jti: claims.jti,
      exp: claims.exp,
    };
  }

  private decode(
    token: string,
  ): Omit<Principal, 'roles'> & { sub: string; tokenVersion: number } {
    let payload: AccessTokenClaims;
    try {
      const raw = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof raw === 'string') throw new Error('string payload');
      payload = raw as AccessTokenClaims;
    } catch {
      throw new AppError('AUTH_TOKEN_INVALID');
    }
    const { sub, email, tenantId, jti, exp, tv } = payload;
    if (
      !nonEmpty(sub) ||
      !nonEmpty(jti) ||
      !isTenantId(tenantId) ||
      typeof exp !== 'number' ||
      (tv !== undefined && !Number.isInteger(tv))
    ) {
      throw new AppError('AUTH_TOKEN_INVALID');
    }
    return {
      sub,
      tokenVersion: (tv as number | undefined) ?? 0,
      userId: sub,
      email: typeof email === 'string' ? email : '',
      tenantId,
      jti,
      exp,
    };
  }

  private async guardStores<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'Credentials cannot be verified right now',
        cause: err,
      });
    }
  }
}
