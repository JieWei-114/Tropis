import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { AUDITED_KEY } from './audited.decorator';
import { getRequestId } from '../middleware/correlation-id.middleware';
import { AuditLogService } from './audit-log.service';
import { AUDIT_OUTCOME } from './audit.constants';
import { IAuditEntry } from './audit.interface';
import type { TenantId } from '../keyspace';

interface HttpAuditRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  user?: { userId?: string; tenantId?: TenantId };
  tenantId?: TenantId;
}

/**
 * Writes an audit entry for every HTTP handler marked with @Audited('action').
 * Captures actor (the authenticated req.user), tenant, resource, outcome and
 * trace id, then fire-and-forget inserts into ClickHouse logs.audit_log via
 * AuditLogService, so audit failures never affect the request.
 *
 * RPC handlers are audited by the RpcServer's audit interceptor
 * (infrastructure/rpc/interceptors/audit.interceptor.ts), which writes the
 * same entry shape with transport `rpc`.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditLog: AuditLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const action = this.reflector.getAllAndOverride<string | undefined>(
      AUDITED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!action) return next.handle();

    const base = this.buildBaseEntry(action, context);

    return next.handle().pipe(
      tap(() => {
        this.auditLog.record({
          ...base,
          outcome: AUDIT_OUTCOME.SUCCESS,
          timestamp: new Date(),
        });
      }),
      catchError((err: unknown) => {
        this.auditLog.record({
          ...base,
          outcome: AUDIT_OUTCOME.ERROR,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date(),
        });
        return throwError(() => err);
      }),
    );
  }

  private buildBaseEntry(
    action: string,
    context: ExecutionContext,
  ): Omit<IAuditEntry, 'outcome' | 'timestamp' | 'error'> {
    const req = context.switchToHttp().getRequest<HttpAuditRequest>();
    const user = req?.user;
    return {
      action,
      actorUserId: user?.userId ?? '',
      tenantId: user?.tenantId ?? req?.tenantId,
      resource:
        `${req?.method ?? ''} ${req?.originalUrl ?? req?.url ?? ''}`.trim(),
      transport: 'http',
      traceId: getRequestId(),
    };
  }
}
