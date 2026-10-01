import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../../../common/errors';
import { corsOriginFromEnv } from '../../../config/cors.constants';
import { CLIENT_HEADER } from '../constants/auth.constants';

const SAME_SITE_FETCH = new Set(['same-origin', 'same-site']);

/**
 * CSRF defence for the endpoints that act on the refresh cookie (refresh,
 * logout). The request must carry `X-Tropis-Client: 1`, a header a
 * cross-site form or image cannot send and a cross-origin script cannot
 * send without a CORS preflight, and come from an allowed origin: an Origin
 * in the CORS allow-list, or no Origin with a same-origin/same-site
 * Sec-Fetch-Site. Anything else is AUTH_CSRF_REJECTED.
 */
@Injectable()
export class CookieCsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (header(req, CLIENT_HEADER) !== '1' || !fromAllowedOrigin(req)) {
      throw new AppError('AUTH_CSRF_REJECTED');
    }
    return true;
  }
}

function fromAllowedOrigin(req: Request): boolean {
  const origin = header(req, 'origin');
  if (origin) return corsOriginFromEnv().includes(origin);
  const site = header(req, 'sec-fetch-site');
  return site !== undefined && SAME_SITE_FETCH.has(site);
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
