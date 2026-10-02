/**
 * Browser and native-shell origins allowed by CORS, and the origin used for
 * OAuth redirects.
 *
 * `CORS_ORIGIN` is a comma-separated list, because the allow-list must hold
 * more than one origin: a single value would be echoed back for every request
 * regardless of the caller's Origin, and the packaged clients (the Tauri
 * desktop shell and the two Capacitor apps) would receive a mismatched
 * Access-Control-Allow-Origin and have every response blocked by their
 * webviews.
 *
 * Native shells serve their bundle from a custom scheme rather than a network
 * origin, so those origins are constants rather than deployment settings and
 * are always allowed. A web page cannot forge an Origin header, and each origin
 * has its own storage, so listing them does not widen the browser attack
 * surface.
 */

import {
  DEFAULT_NATIVE_OAUTH_REDIRECT,
  NATIVE_SESSION_ORIGINS,
} from '@tropis/shared';

export { DEFAULT_NATIVE_OAUTH_REDIRECT, NATIVE_SESSION_ORIGINS };

/** Web console (Vite dev server). */
export const DEFAULT_CORS_ORIGIN = 'http://localhost:5173';

/**
 * Fixed origins of the packaged clients:
 *   - `tauri://localhost`      Tauri v2 on macOS and Linux
 *   - `http://tauri.localhost` Tauri v2 on Windows
 *   - `capacitor://localhost`  Capacitor on iOS
 *   - `http://localhost`       Capacitor on Android (its default scheme)
 *   - `https://localhost`      Capacitor on Android with `androidScheme: https`
 */
export const NATIVE_APP_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
] as const;

/**
 * Resolves the allow-list. `CORS_ORIGIN` may name several web origins,
 * comma-separated; the native origins above are appended unconditionally.
 */
export function corsOriginFromEnv(): string[] {
  return corsOriginList(process.env['CORS_ORIGIN']);
}

/** The allow-list for a CORS_ORIGIN value (the validated config's, say). */
export function corsOriginList(value: string | undefined): string[] {
  const configured = (value ?? DEFAULT_CORS_ORIGIN)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  return [...new Set([...configured, ...NATIVE_APP_ORIGINS])];
}

/**
 * Single origin for OAuth redirects and absolute links — the FIRST configured
 * web origin. A native shell cannot be the target of a provider redirect, so
 * the native origins never apply here.
 */
export function primaryWebOrigin(): string {
  return corsOriginFromEnv()[0] ?? DEFAULT_CORS_ORIGIN;
}

/**
 * Whether a request Origin may use the native session flow (refresh token
 * in the body): one of NATIVE_SESSION_ORIGINS and not a configured web
 * origin, so the console's own pages never obtain a refresh token. A local
 * page on https://localhost or http://tauri.localhost can send these
 * origins too, but must still present credentials it already holds.
 */
export function isNativeSessionOrigin(
  origin: string | undefined,
  corsOrigin: string | undefined = process.env['CORS_ORIGIN'],
): boolean {
  if (!origin) return false;
  if (!(NATIVE_SESSION_ORIGINS as readonly string[]).includes(origin)) {
    return false;
  }
  const web = (corsOrigin ?? DEFAULT_CORS_ORIGIN)
    .split(',')
    .map((o) => o.trim());
  return !web.includes(origin);
}

const WEB_SCHEMES = new Set([
  'http:',
  'https:',
  'javascript:',
  'data:',
  'file:',
  'blob:',
  'about:',
  'vbscript:',
  'ftp:',
  'ws:',
  'wss:',
]);

/**
 * A custom-scheme callback URL a native shell registers (`tropis://auth/callback`):
 * a parsable URL with a non-web scheme, no credentials and no fragment.
 */
export function isNativeCallbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (WEB_SCHEMES.has(url.protocol)) return false;
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return false;
  if (url.username || url.password || url.hash || value.includes('#')) {
    return false;
  }
  return true;
}

/**
 * The OAuth return allow-list for native shells from NATIVE_OAUTH_REDIRECTS
 * (comma-separated; empty disables native OAuth).
 */
export function nativeOAuthRedirectList(value: string | undefined): string[] {
  return (value ?? DEFAULT_NATIVE_OAUTH_REDIRECT)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}
