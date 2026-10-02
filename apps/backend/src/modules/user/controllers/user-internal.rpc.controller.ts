import type { MessageInitShape } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
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
 * ClusterIP-only and NetworkPolicy-restricted. Zero-trust all the same: the
 * internal tier's service identity (`x-service-token` against SERVICE_TOKEN,
 * infrastructure/rpc/interceptors/service-identity.interceptor.ts) is
 * checked before validation and before this handler runs.
 */
@RpcService(UserInternalService)
export class UserInternalRpcController implements ServiceImpl<
  typeof UserInternalService
> {
  constructor(
    private readonly userService: UserService,
    private readonly tenantCtx: TenantContext,
  ) {}

  @RpcValidate(GetUserByEmailRpcDto)
  async getUserByEmail(
    req: GetUserByEmailRequest,
  ): Promise<MessageInitShape<typeof InternalUserResponseSchema>> {
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
}
