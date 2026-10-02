import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { requestCredentials } from '../../../common/auth/request-credentials';
import {
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '../../../common/auth/token-verifier.port';
import type { TenantId } from '../../../common/keyspace';
import { refreshCookieOf } from '../cookies/refresh-cookie';
import { AuthService } from '../services/auth.service';
import { sessionClientOf } from './native-client.guard';

type ActorRequest = Request & {
  user?: { userId?: string; tenantId?: TenantId };
};

/**
 * Logout is public, so no auth guard names the caller. This guard does, for
 * the audit entry: the principal of a valid access token, else the owner of
 * the presented refresh token (cookie or native body). Never rejects.
 */
@Injectable()
export class LogoutActorGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    if (req.user?.userId) return true;
    const { principal } = await requestCredentials(req, this.verifier);
    if (principal) {
      req.user = principal;
      return true;
    }
    const owner = this.auth.refreshTokenOwner(
      isNative(req) ? bodyToken(req) : refreshCookieOf(req),
    );
    if (owner) req.user = owner;
    return true;
  }
}

function bodyToken(req: Request): string | undefined {
  const token = (req.body as { refreshToken?: unknown } | undefined)
    ?.refreshToken;
  return typeof token === 'string' && token ? token : undefined;
}

function isNative(req: Request): boolean {
  try {
    return sessionClientOf(req) === 'native';
  } catch {
    return false;
  }
}
