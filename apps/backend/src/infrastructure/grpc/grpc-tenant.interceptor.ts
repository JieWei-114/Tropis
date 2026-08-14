import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Scope,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { TenantContext } from '../../common/tenant/tenant.context';
import { DEFAULT_TENANT } from '../../modules/user/schemas/user.schema';
import { resolveAuthorizationHeader } from './grpc.utils';

/**
 * Sets TenantContext for every inbound gRPC call.
 * Mirrors what TenantMiddleware does for HTTP requests.
 *
 * Priority:
 *   1. JWT `tenantId` claim in Authorization metadata header
 *   2. Falls back to DEFAULT_TENANT ('default')
 */
@Injectable({ scope: Scope.REQUEST })
export class GrpcTenantInterceptor implements NestInterceptor {
  private readonly jwtSecret: string;

  constructor(
    private readonly tenantCtx: TenantContext,
    config: ConfigService,
  ) {
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const rpcCtx = context.switchToRpc();
    const metadata = rpcCtx.getContext<unknown>();

    let tenantId = DEFAULT_TENANT;
    const token = resolveAuthorizationHeader(metadata);
    if (token) {
      try {
        const payload = jwt.verify(token, this.jwtSecret) as {
          tenantId?: string;
        };
        if (payload.tenantId) tenantId = payload.tenantId;
      } catch {
        // invalid token — auth guards handle rejection separately
      }
    }

    this.tenantCtx.set(tenantId);
    return next.handle();
  }
}
