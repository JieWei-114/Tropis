import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagsService } from './feature-flags.service';

export const FEATURE_FLAG_KEY = 'feature_flag';

/** Mark a handler as gated behind a feature flag. */
export const FeatureFlag =
  (flag: string) =>
  (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    Reflect.defineMetadata(FEATURE_FLAG_KEY, flag, descriptor?.value ?? target);
    return descriptor ?? target;
  };

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly flags: FeatureFlagsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const flag = this.reflector.get<string | undefined>(
      FEATURE_FLAG_KEY,
      ctx.getHandler(),
    );
    if (!flag) return true; // no flag required — always allow

    const enabled = await this.flags.isEnabled(flag);
    if (!enabled)
      throw new ForbiddenException(`Feature "${flag}" is not enabled`);
    return true;
  }
}
