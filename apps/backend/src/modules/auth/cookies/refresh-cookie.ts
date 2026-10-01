import type { Request, Response } from 'express';
import type { ConfigService } from '@nestjs/config';
import {
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../constants/auth.constants';

/** One cookie from the request's Cookie header. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Secure unless NODE_ENV is development or test; COOKIE_SECURE overrides
 * either way.
 */
export function cookieSecure(config: ConfigService): boolean {
  const explicit = config.get<string | boolean>('COOKIE_SECURE');
  if (explicit !== undefined && explicit !== '') {
    return explicit === true || explicit === 'true';
  }
  const env = config.get<string>('NODE_ENV');
  return env !== 'development' && env !== 'test';
}

/** The refresh token as an HttpOnly, SameSite=Strict cookie on /api/auth. */
export function setRefreshCookie(
  res: Response,
  token: string,
  secure: boolean,
): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
}

export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.cookie(REFRESH_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: REFRESH_COOKIE_PATH,
    maxAge: 0,
  });
}

export function refreshCookieOf(req: Request): string | undefined {
  return readCookie(req, REFRESH_COOKIE) || undefined;
}
