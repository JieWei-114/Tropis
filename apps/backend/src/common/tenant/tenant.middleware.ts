import { Injectable, NestMiddleware, Inject } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.module';
import { DEFAULT_TENANT } from '../../modules/user/schemas/user.schema';

interface JwtPayloadWithTenant {
  tenantId?: string;
  jti?: string;
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
    config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    let tenantId = DEFAULT_TENANT;
    let jwtTenantResolved = false;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(
          authHeader.slice(7),
          this.jwtSecret,
        ) as JwtPayloadWithTenant;
        // Don't resolve tenant from a revoked (logged-out) token — mirrors the
        // JwtStrategy blacklist check so tenant context can't outlive a logout.
        const revoked =
          payload.jti &&
          (await this.redis.exists(`bl:${payload.jti}`).catch(() => 0)) === 1;
        if (payload.tenantId && !revoked) {
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

    // Resolution only. Binding into TenantContext happens in the global
    // interceptor (GrpcTenantInterceptor), which reads this field: an
    // AsyncLocalStorage store entered here in the middleware does NOT reach the
    // route handler, because Nest composes the rest of the pipeline in the
    // async context that existed when the request started.
    (req as unknown as { tenantId?: string }).tenantId = tenantId;
    next();
  }
}
