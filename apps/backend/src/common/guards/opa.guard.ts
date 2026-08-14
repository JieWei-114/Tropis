import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OpaService } from '../../infrastructure/opa/opa.service';
import { OPA_POLICY_KEY, OpaPolicy } from '../decorators/opa-policy.decorator';
import { UserRole } from '../../modules/user/schemas/user.schema';

@Injectable()
export class OpaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly opaService: OpaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<OpaPolicy | undefined>(
      OPA_POLICY_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @OpaPolicy() decorator — skip OPA check
    if (!policy) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ user?: { roles?: UserRole[] } }>();
    const roles: UserRole[] = request.user?.roles ?? [];

    const allowed = await this.opaService.allow({
      roles,
      resource: policy.resource,
      action: policy.action,
    });

    if (!allowed) {
      throw new ForbiddenException(
        `OPA denied: ${policy.action} on ${policy.resource}`,
      );
    }

    return true;
  }
}
