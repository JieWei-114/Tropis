import type { MessageInitShape } from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { Audited } from '../../../common/audit/audited.decorator';
import { TenantContext } from '../../../common/tenant/tenant.context';
import { AuthService as AuthDomainService } from '../services/auth.service';
import { AppError } from '../../../common/errors';
import { LoginLockoutService } from '../services/login-lockout.service';
import { RpcService } from '../../../infrastructure/rpc/rpc-service.decorator';
import { RpcValidate } from '../../../infrastructure/rpc/rpc-validate.decorator';
import { LoginRpcDto } from '../dto/auth-rpc.dto';
import {
  RpcAuthzService,
  rpcClientAddress,
} from '../../../infrastructure/rpc/rpc-authz.service';
import {
  AuthService,
  type CurrentUserResponseSchema,
  type EmptyRequest,
  type LoginRequest,
  type LoginResponseSchema,
} from '../../../gen/auth/v1/auth_pb';

/**
 * Implements tropis.auth.v1.AuthService (proto/auth/v1/auth.proto).
 *
 * Login runs the same credential check as the REST login (lockout, password,
 * account status, session record) in the tenant named by X-Tenant-ID, plus a
 * per-email attempt limit, and returns an access token only; the refresh
 * token comes from the REST login.
 */
@RpcService(AuthService)
export class AuthRpcController implements ServiceImpl<typeof AuthService> {
  constructor(
    private readonly auth: AuthDomainService,
    private readonly lockout: LoginLockoutService,
    private readonly authz: RpcAuthzService,
    private readonly tenantCtx: TenantContext,
  ) {}

  @Audited('auth.login')
  @RpcValidate(LoginRpcDto)
  async login(
    req: LoginRequest,
    ctx: HandlerContext,
  ): Promise<MessageInitShape<typeof LoginResponseSchema>> {
    const tenantId = this.tenantCtx.tenant;
    if (!req.email || !req.password) {
      throw new AppError('AUTH_INVALID_CREDENTIALS');
    }
    await this.lockout.assertRpcLoginAllowed(tenantId, req.email);
    const accessToken = await this.auth.loginAccessOnly(
      tenantId,
      { email: req.email, password: req.password },
      rpcClientAddress(ctx),
    );
    return { accessToken };
  }

  getCurrentUser(
    _req: EmptyRequest,
    ctx: HandlerContext,
  ): MessageInitShape<typeof CurrentUserResponseSchema> {
    const caller = this.authz.caller(ctx);
    return { userId: caller.sub, email: caller.email };
  }
}
