import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { UserService } from '../services/user.service';

interface GetUserByEmailRequest {
  email: string;
}

interface InternalUserResponse {
  id: string;
  name: string;
  email: string;
  age: number;
  status: string;
  login_count: number;
}

/**
 * Internal-tier gRPC handler — tropis.user.internal.v1.UserInternalService
 * (proto/user/internal/v1/user_internal.proto, docs/api-conventions.md).
 *
 * Zero-trust: even though this service is only reachable inside the cluster
 * (served on the dedicated internal port :50061 — GRPC_INTERNAL_PORT — never
 * routed through Envoy; ClusterIP-only Service + NetworkPolicy), callers
 * must still authenticate with a service identity. Template implementation:
 * shared secret in `x-service-token` metadata compared constant-time against
 * the SERVICE_TOKEN env var. Production should replace this with transport-
 * level identity (mTLS / SPIFFE via a service mesh) — the token check is the
 * portable lowest common denominator.
 *
 * When SERVICE_TOKEN is unset the internal tier is disabled and every call
 * returns UNIMPLEMENTED (documented in .env.example).
 */
@Controller()
export class GrpcUserInternalService {
  constructor(
    private readonly userService: UserService,
    private readonly config: ConfigService,
  ) {}

  @GrpcMethod('UserInternalService', 'GetUserByEmail')
  async getUserByEmail(
    request: GetUserByEmailRequest,
    metadata: Metadata,
  ): Promise<InternalUserResponse> {
    this.assertServiceIdentity(metadata);

    if (!request.email) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'email is required',
      });
    }

    // findByEmailWithPassword is the only email lookup that bypasses the
    // cache; we strip the sensitive fields before returning.
    const user = await this.userService.findByEmailWithPassword(request.email);
    if (!user) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: `User not found: ${request.email}`,
      });
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      age: user.age ?? 0,
      status: user.status,
      login_count: user.loginCount,
    };
  }

  private assertServiceIdentity(metadata: Metadata): void {
    const expected = this.config.get<string>('SERVICE_TOKEN', '');
    if (!expected) {
      throw new RpcException({
        code: GrpcStatus.UNIMPLEMENTED,
        message: 'Internal tier disabled (SERVICE_TOKEN not configured)',
      });
    }

    const raw = metadata.get('x-service-token')[0];
    const given = typeof raw === 'string' ? raw : '';
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'Invalid or missing x-service-token',
      });
    }
  }
}
