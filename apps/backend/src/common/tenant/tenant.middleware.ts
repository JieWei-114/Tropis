import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import type { TenantId } from '../keyspace';
import { requestCredentials } from '../auth/request-credentials';
import {
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '../auth/token-verifier.port';
import { resolveTenant } from './tenant-resolution';

export const TENANT_HEADER = 'x-tenant-id';
/** Query form of the tenant hint, for callers that cannot set headers (sendBeacon). */
export const TENANT_QUERY_PARAM = 'tenant';

export interface TenantResolvedRequest {
  tenantId?: TenantId;
  tenantError?: unknown;
}

function tenantHint(req: Request): unknown {
  const header = req.headers[TENANT_HEADER];
  if (typeof header === 'string' && header) return header;
  const query = (req.query as Record<string, unknown> | undefined)?.[
    TENANT_QUERY_PARAM
  ];
  return typeof query === 'string' ? query : undefined;
}

/**
 * Resolves the tenant of every HTTP request (rules in tenant-resolution.ts)
 * from the verified token and the tenant hint, and records the outcome on
 * the request. It never rejects: HttpTenantInterceptor binds the tenant or
 * throws the recorded error, so the error goes through the exception filter.
 * The token verification is memoized for JwtAuthGuard.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const out = req as Request & TenantResolvedRequest;
    const { principal } = await requestCredentials(req, this.verifier);
    try {
      out.tenantId = resolveTenant(principal?.tenantId, tenantHint(req));
    } catch (err) {
      out.tenantError = err;
    }
    next();
  }
}
