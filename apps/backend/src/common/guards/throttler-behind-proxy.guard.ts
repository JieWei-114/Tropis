import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerRequest,
} from '@nestjs/throttler';
import { Injectable, ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../errors/app-error';

const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const DEFAULT_THROTTLER = 'default';

/**
 * Reads the real IP from X-Forwarded-For when running behind a reverse proxy.
 *
 * A named throttler other than `default` applies only to the routes that
 * select it with @Throttle({ <name>: ... }); `default` applies everywhere.
 * A rejected request answers RATE_LIMITED with a standard `Retry-After`
 * header, whatever throttler rejected it.
 *
 * HTTP-only. It is a global APP_GUARD, so it would otherwise run for
 * WebSocket contexts too — where ThrottlerGuard tries to write rate-limit
 * response headers and throws `res.header is not a function`. RPC calls are
 * served by RpcServer outside the Nest guard pipeline and are not
 * rate-limited here; AuthService/Login keeps its own per-email limit
 * (auth.rpc.controller.ts).
 */
@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    return super.canActivate(context);
  }

  protected async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const name = props.throttler.name ?? DEFAULT_THROTTLER;
    if (name !== DEFAULT_THROTTLER && !declares(props.context, name)) {
      return true;
    }
    return super.handleRequest(props);
  }

  protected throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const seconds = String(Math.max(1, Math.ceil(detail.timeToBlockExpire)));
    const res = context.switchToHttp().getResponse<Response>();
    for (const header of Object.keys(res.getHeaders?.() ?? {})) {
      if (header.startsWith('retry-after-')) res.removeHeader(header);
    }
    throw new AppError('RATE_LIMITED', {
      metadata: { retryAfterSeconds: seconds },
    });
  }

  protected getTracker(req: { ips?: string[]; ip?: string }): Promise<string> {
    return Promise.resolve((req.ips?.length ? req.ips[0] : req.ip) as string);
  }
}

function declares(context: ExecutionContext, name: string): boolean {
  const key = `${THROTTLER_LIMIT}${name}`;
  return [context.getHandler(), context.getClass()].some(
    (target) => target && Reflect.hasMetadata(key, target),
  );
}
