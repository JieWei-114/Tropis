import { ThrottlerGuard } from '@nestjs/throttler';
import { Injectable } from '@nestjs/common';

/** Reads real IP from X-Forwarded-For when running behind a reverse proxy. */
@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return (req.ips?.length ? req.ips[0] : req.ip) as string;
  }
}
