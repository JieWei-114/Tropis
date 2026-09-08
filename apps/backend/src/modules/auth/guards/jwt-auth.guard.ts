import { Injectable, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';

/**
 * Registered as a global APP_GUARD in app.module.ts, so HTTP routes are closed
 * by default and @Public() is the explicit opt-out.
 *
 * gRPC is skipped deliberately: this is a passport HTTP guard with no request
 * object in an RPC context, and the gRPC controllers do their own explicit
 * token verification (`extractToken` + `assertOpa`).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // Non-HTTP transports (gRPC) authenticate themselves — see class docs.
    if (context.getType() !== 'http') return true;

    // Check @Public() on the handler AND the controller class
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    return super.canActivate(context);
  }
}
