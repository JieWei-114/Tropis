import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../errors';
import {
  POLICY,
  type PolicyPort,
} from '../../infrastructure/policy/policy.port';
import type { Permission } from './authorize.decorator';

/**
 * Role-based decisions through the policy capability. `assert` is what
 * @Authorize enforces; `allows` is for a handler that branches on a
 * permission instead of requiring it.
 */
@Injectable()
export class AuthorizationService {
  constructor(@Inject(POLICY) private readonly policy: PolicyPort) {}

  allows(roles: readonly string[], permission: Permission): Promise<boolean> {
    return this.policy.allow({ roles, ...permission });
  }

  async assert(
    roles: readonly string[],
    permission: Permission,
  ): Promise<void> {
    if (!(await this.allows(roles, permission))) {
      throw new AppError('FORBIDDEN', {
        detail: `Permission denied: ${permission.action} on ${permission.resource}`,
      });
    }
  }
}
