import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { runInTenant } from '../tenant/tenant.context';
import type { TenantResolvedRequest } from '../tenant/tenant.middleware';
import { setSpanTenant } from '../observability/propagation';
import { setRequestTenant } from '../observability/request-context';

/**
 * Binds the tenant TenantMiddleware resolved for an HTTP request around the
 * handler, or rethrows the resolution error (TENANT_INVALID,
 * TENANT_MISMATCH). A request without a tenant runs unscoped, so a
 * tenant-scoped read in it fails with TENANT_REQUIRED. The tenant is also
 * recorded on the request context and the active span.
 *
 * RPC calls are bound by the RpcServer's tenant interceptor instead.
 */
@Injectable()
export class HttpTenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context
      .switchToHttp()
      .getRequest<TenantResolvedRequest | undefined>();
    if (req?.tenantError) return throwError(() => req.tenantError);
    const tenantId = req?.tenantId;
    if (!tenantId) return next.handle();
    setRequestTenant(tenantId);
    setSpanTenant(tenantId);

    // The handler runs when the observable is subscribed, so the tenant scope
    // has to wrap the subscribe.
    return new Observable((subscriber) =>
      runInTenant(tenantId, () => next.handle().subscribe(subscriber)),
    );
  }
}
