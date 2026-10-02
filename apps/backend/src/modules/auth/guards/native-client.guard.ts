import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { NATIVE_CLIENT_HEADER_VALUE } from '@tropis/shared';
import { AppError } from '../../../common/errors';
import { isNativeSessionOrigin } from '../../../config/cors.constants';
import { CLIENT_HEADER } from '../constants/auth.constants';
import type { SessionClient } from '../interfaces/session-client.interface';

/**
 * `native` when the request sends `X-Tropis-Client: native` from a native
 * shell origin, `web` without that header. The header from any other origin
 * (a web page, or none) is AUTH_CSRF_REJECTED, so a browser page can never
 * receive a refresh token in a response body.
 */
export function sessionClientOf(req: Request): SessionClient {
  if (header(req, CLIENT_HEADER) !== NATIVE_CLIENT_HEADER_VALUE) return 'web';
  if (!isNativeSessionOrigin(header(req, 'origin'))) {
    throw new AppError('AUTH_CSRF_REJECTED');
  }
  return 'native';
}

/** Admits native-session requests only (the /api/auth/native/* endpoints). */
@Injectable()
export class NativeClientGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (sessionClientOf(req) !== 'native') {
      throw new AppError('AUTH_CSRF_REJECTED');
    }
    return true;
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
