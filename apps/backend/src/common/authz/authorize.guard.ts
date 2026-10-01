import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../errors';
import type { Principal } from '../auth/token-verifier.port';
import { permissionOf } from './authorize.decorator';
import { AuthorizationService } from './authorization.service';

/**
 * Enforces @Authorize on HTTP routes. Registered after the JWT guard, so
 * `req.user` is the verified principal; a route without @Authorize passes.
 */
@Injectable()
export class AuthorizeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const permission = permissionOf(
      this.reflector,
      context.getHandler(),
      context.getClass(),
    );
    if (!permission) return true;
    const req = context.switchToHttp().getRequest<{ user?: Principal }>();
    if (!req.user) throw new AppError('UNAUTHORIZED');
    await this.authorization.assert(req.user.roles ?? [], permission);
    return true;
  }
}
