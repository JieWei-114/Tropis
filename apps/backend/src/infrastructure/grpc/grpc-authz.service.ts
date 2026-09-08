import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import * as jwt from 'jsonwebtoken';
import { OpaService } from '../opa/opa.service';
import {
  UserRole,
  DEFAULT_TENANT,
} from '../../modules/user/schemas/user.schema';

export interface GrpcCaller {
  sub: string;
  email: string;
  roles: UserRole[];
  tenantId: string;
}

/**
 * Token verification plus OPA authorization for gRPC controllers.
 *
 * The user controller grew its own private verifyToken/assertOpa/clampLimit
 * trio, and the analytics controller grew a separate resolveTenantId that
 * verified the same token for tenancy but never authorized anything — which is
 * how that whole service ended up publicly readable and writable. One shared
 * gate means a new RPC cannot forget half of the check.
 */
@Injectable()
export class GrpcAuthzService {
  private readonly jwtSecret: string;

  constructor(
    config: ConfigService,
    private readonly opa: OpaService,
  ) {
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  verify(token: string): GrpcCaller {
    try {
      const p = jwt.verify(token, this.jwtSecret) as Partial<GrpcCaller>;
      return {
        sub: p.sub ?? '',
        email: p.email ?? '',
        roles: p.roles ?? [],
        tenantId: p.tenantId || DEFAULT_TENANT,
      };
    } catch {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Invalid or expired token',
      });
    }
  }

  /** Verifies the token, then asks OPA whether the caller's roles allow this. */
  async assert(
    token: string,
    resource: 'user' | 'analytics',
    action: string,
  ): Promise<GrpcCaller> {
    const caller = this.verify(token);
    const allowed = await this.opa.allow({
      roles: caller.roles,
      resource,
      action,
    });
    if (!allowed) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: `Permission denied: ${action} on ${resource}`,
      });
    }
    return caller;
  }

  /** Bounds a caller-supplied page size so one RPC cannot ask for everything. */
  static clampLimit(
    value: number | undefined,
    fallback: number,
    max: number,
  ): number {
    const n = value && value > 0 ? value : fallback;
    return Math.min(n, max);
  }
}
