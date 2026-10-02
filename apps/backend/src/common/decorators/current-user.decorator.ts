import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Principal } from '../auth/token-verifier.port';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | undefined => {
    const request = ctx.switchToHttp().getRequest<{ user?: Principal }>();
    return request.user;
  },
);
