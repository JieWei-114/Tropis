import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/errors';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { requestCredentials } from '../../../common/auth/request-credentials';
import {
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '../../../common/auth/token-verifier.port';

/**
 * Registered as a global APP_GUARD in app.module.ts, so HTTP routes are closed
 * by default and @Public() is the explicit opt-out. The bearer token goes
 * through the shared TokenVerifier (the verification TenantMiddleware already
 * ran is reused), and the principal becomes `req.user`.
 *
 * Non-HTTP contexts (WebSocket) are skipped: the gateway verifies its own
 * handshake token. RPC calls never reach Nest guards; the RpcServer's
 * authentication interceptor and RpcAuthzService (infrastructure/rpc) verify
 * them.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{ user?: unknown }>();
    const { token, principal, error } = await requestCredentials(
      req,
      this.verifier,
    );
    if (principal) {
      req.user = principal;
      return true;
    }
    if (!token) throw new AppError('UNAUTHORIZED');
    throw error instanceof Error ? error : new AppError('AUTH_TOKEN_INVALID');
  }
}
