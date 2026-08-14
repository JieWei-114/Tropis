import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import * as jwt from 'jsonwebtoken';
import { AUDITED_KEY } from '../decorators/audited.decorator';
import { getRequestId } from '../middleware/correlation-id.middleware';
import { AuditLogService } from '../../modules/audit/services/audit-log.service';
import { AUDIT_OUTCOME } from '../../modules/audit/constants';
import { IAuditEntry } from '../../modules/audit/interfaces';
import { resolveAuthorizationHeader } from '../../infrastructure/grpc/grpc.utils';
import { DEFAULT_TENANT } from '../../modules/user/schemas/user.schema';

interface HttpAuditRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  user?: { userId?: string; sub?: string; tenantId?: string };
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Writes an audit entry for every handler marked with @Audited('action').
 * Captures actor (JWT if present), tenant, resource, outcome and trace id,
 * then fire-and-forget inserts into ClickHouse logs.audit_log via
 * AuditLogService — audit failures never affect the request.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditLog: AuditLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
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
    const traceId = getRequestId();

    if (context.getType() === 'rpc') {
      const metadata = context.switchToRpc().getContext<unknown>();
      const { actorUserId, tenantId } = this.actorFromToken(
        resolveAuthorizationHeader(metadata),
      );
      return {
        action,
        actorUserId,
        tenantId,
        resource: `${context.getClass().name}.${context.getHandler().name}`,
        transport: 'rpc',
        traceId,
      };
    }

    const req = context.switchToHttp().getRequest<HttpAuditRequest>();
    const user = req?.user;
    return {
      action,
      actorUserId: user?.userId ?? user?.sub ?? '',
      tenantId: user?.tenantId ?? DEFAULT_TENANT,
      resource:
        `${req?.method ?? ''} ${req?.originalUrl ?? req?.url ?? ''}`.trim(),
      transport: 'http',
      traceId,
    };
  }

  /**
   * Best-effort actor extraction for gRPC — decodes (does not verify) the
   * bearer token; authenticity is enforced separately by the handlers.
   */
  private actorFromToken(token: string | undefined): {
    actorUserId: string;
    tenantId: string;
  } {
    if (!token) return { actorUserId: '', tenantId: DEFAULT_TENANT };
    try {
      const payload = jwt.decode(token) as {
        sub?: string;
        tenantId?: string;
      } | null;
      return {
        actorUserId: payload?.sub ?? '',
        tenantId: payload?.tenantId ?? DEFAULT_TENANT,
      };
    } catch {
      return { actorUserId: '', tenantId: DEFAULT_TENANT };
    }
  }
}
