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
  const configured = (process.env['CORS_ORIGIN'] ?? DEFAULT_CORS_ORIGIN)
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
