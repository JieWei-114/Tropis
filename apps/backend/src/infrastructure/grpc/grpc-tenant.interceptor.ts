import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { TenantContext } from '../../common/tenant/tenant.context';
import { DEFAULT_TENANT } from '../../modules/user/schemas/user.schema';
import { resolveAuthorizationHeader } from './grpc.utils';

/**
 * Binds TenantContext for every inbound call, gRPC and HTTP alike.
 *
 * It is registered as an APP_INTERCEPTOR, so it already ran for HTTP requests
 * too — but it only ever read gRPC metadata, and on HTTP `switchToRpc()
 * .getContext()` returns the Express *response*, whose `authorization` is
 * undefined. So HTTP requests were inside a store that always held
 * DEFAULT_TENANT, and a user created over gRPC under tenant `acme` was
 * invisible to every REST route. Reading the HTTP request here closes that.
 *
 * Priority:
 *   gRPC: JWT `tenantId` claim in the Authorization metadata header
 *   HTTP: `req.tenantId`, already resolved by TenantMiddleware (which also
 *         enforces the JWT-over-header precedence and the revocation check)
 *   both: falls back to DEFAULT_TENANT ('default')
 */
@Injectable()
export class GrpcTenantInterceptor implements NestInterceptor {
  private readonly jwtSecret: string;

  constructor(
    private readonly tenantCtx: TenantContext,
    config: ConfigService,
  ) {
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tenantId =
      context.getType() === 'http'
        ? this.fromHttp(context)
        : this.fromRpc(context);

    // The handler executes when the observable is SUBSCRIBED, not when
    // next.handle() is called — so the AsyncLocalStorage context has to wrap
    // the subscribe, otherwise the handler runs outside it.
    return new Observable((subscriber) =>
      this.tenantCtx.run(tenantId, () => next.handle().subscribe(subscriber)),
    );
  }

  /** TenantMiddleware already resolved and validated this. */
  private fromHttp(context: ExecutionContext): string {
    const req = context
      .switchToHttp()
      .getRequest<{ tenantId?: string } | undefined>();
    return req?.tenantId || DEFAULT_TENANT;
  }

  private fromRpc(context: ExecutionContext): string {
    const metadata = context.switchToRpc().getContext<unknown>();
    const token = resolveAuthorizationHeader(metadata);
    if (!token) return DEFAULT_TENANT;
    try {
      const payload = jwt.verify(token, this.jwtSecret) as {
        tenantId?: string;
      };
      return payload.tenantId || DEFAULT_TENANT;
    } catch {
      // invalid token — auth guards handle rejection separately
      return DEFAULT_TENANT;
    }
  }
}
