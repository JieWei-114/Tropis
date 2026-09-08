import { ThrottlerGuard } from '@nestjs/throttler';
import { Injectable, ExecutionContext } from '@nestjs/common';

/**
 * Reads the real IP from X-Forwarded-For when running behind a reverse proxy.
 *
 * HTTP-only. It is a global APP_GUARD and the gRPC listeners inherit the app
 * config, so it would otherwise run for RPCs too — where ThrottlerGuard tries
 * to write rate-limit response headers and throws `res.header is not a
 * function`, turning every gRPC call into an INTERNAL error. gRPC is rate
 * limited at the edge (Envoy) instead.
 */
@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    return super.canActivate(context);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    return (req.ips?.length ? req.ips[0] : req.ip) as string;
  }
}
