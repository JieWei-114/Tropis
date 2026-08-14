import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { TenantContext } from './tenant.context';
import { DEFAULT_TENANT } from '../../modules/user/schemas/user.schema';

interface JwtPayloadWithTenant {
  tenantId?: string;
}

/**
 * Extracts tenantId for every HTTP request in priority order:
 *   1. JWT `tenantId` claim (authenticated users) — locked; header cannot override
 *   2. X-Tenant-ID header (unauthenticated service-to-service calls only)
 *   3. Falls back to DEFAULT_TENANT ('default')
 *
 * Never throws — unauthenticated or invalid tokens still proceed;
 * auth guards handle authentication separately.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly jwtSecret: string;

  constructor(
    private readonly tenantCtx: TenantContext,
    config: ConfigService,
  ) {
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    let tenantId = DEFAULT_TENANT;
    let jwtTenantResolved = false;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(
          authHeader.slice(7),
          this.jwtSecret,
        ) as JwtPayloadWithTenant;
        if (payload.tenantId) {
          tenantId = payload.tenantId;
          jwtTenantResolved = true;
        }
      } catch {
        // invalid token — auth guard will handle rejection; we just skip tenant extraction
      }
    }

    // Only allow header override when no JWT tenant is present (unauthenticated machine clients).
    // Preventing authenticated users from switching tenants via header stops tenant-hopping attacks.
    if (!jwtTenantResolved) {
      const headerTenant = req.headers['x-tenant-id'];
      if (typeof headerTenant === 'string' && headerTenant) {
        tenantId = headerTenant;
      }
    }

    this.tenantCtx.set(tenantId);
    next();
  }
}
