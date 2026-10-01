import type { MessageInitShape } from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { AppError } from '../../../common/errors';
import { UserService } from '../services/user.service';
import { TenantContext } from '../../../common/tenant/tenant.context';
import { RpcService } from '../../../infrastructure/rpc/rpc-service.decorator';
import { RpcValidate } from '../../../infrastructure/rpc/rpc-validate.decorator';
import { GetUserByEmailRpcDto } from '../dto/user-rpc.dto';
import {
  UserInternalService,
  type GetUserByEmailRequest,
  type InternalUserResponseSchema,
} from '../../../gen/user/internal/v1/user_internal_pb';

/**
 * Internal-tier handler: tropis.user.internal.v1.UserInternalService
 * (proto/user/internal/v1/user_internal.proto, docs/api-conventions.md).
 *
 * Served only on the internal listener (RPC_INTERNAL_PORT), which is
 * ClusterIP-only and NetworkPolicy-restricted. Zero-trust all the same:
 * callers must present a service identity, a shared secret in the
 * `x-service-token` header compared constant-time against SERVICE_TOKEN.
 * Production should replace this with transport-level identity (mTLS /
 * SPIFFE via a service mesh); the token check is the portable lowest common
 * denominator.
 *
 * When SERVICE_TOKEN is unset the internal tier is disabled and every call
 * returns UNIMPLEMENTED.
 */
@RpcService(UserInternalService)
export class UserInternalRpcController implements ServiceImpl<
  typeof UserInternalService
> {
  constructor(
    private readonly userService: UserService,
    private readonly config: ConfigService,
    private readonly tenantCtx: TenantContext,
  ) {}

  @RpcValidate(GetUserByEmailRpcDto)
  async getUserByEmail(
    req: GetUserByEmailRequest,
    ctx: HandlerContext,
  ): Promise<MessageInitShape<typeof InternalUserResponseSchema>> {
    this.assertServiceIdentity(ctx);

    if (!req.email) {
      throw AppError.validation([
        { field: 'email', description: 'email is required' },
      ]);
    }

    // findByEmailWithPassword is the only email lookup that bypasses the
    // cache; the sensitive fields are stripped before returning.
    const user = await this.userService.findByEmailWithPassword(
      this.tenantCtx.tenant,
      req.email,
    );
    if (!user) {
      throw new AppError('USER_NOT_FOUND');
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      age: user.age ?? 0,
      status: user.status,
      loginCount: user.loginCount,
    };
  }

  private assertServiceIdentity(ctx: HandlerContext): void {
    const expected = this.config.getOrThrow<string>('SERVICE_TOKEN');
    if (!expected) {
      throw new AppError('NOT_IMPLEMENTED', {
        detail: 'The internal tier is disabled on this server',
      });
    }

    const given = ctx.requestHeader.get('x-service-token') ?? '';
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError('FORBIDDEN', {
        detail: 'Invalid or missing x-service-token',
      });
    }
  }
}
