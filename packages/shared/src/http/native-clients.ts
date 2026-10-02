/**
 * The native shells (Tauri, Capacitor) cannot hold the browser refresh
 * cookie, so they keep the refresh token in OS secure storage and declare
 * themselves with `x-tropis-client: native` (docs/api-conventions.md).
 */

/** The `x-tropis-client` value of a native shell. */
export const NATIVE_CLIENT_HEADER_VALUE = 'native';

/**
 * Origins a native-session request may come from:
 *   - `tauri://localhost`      Tauri on macOS and Linux
 *   - `http://tauri.localhost` Tauri on Windows
 *   - `capacitor://localhost`  Capacitor on iOS
 *   - `https://localhost`      Capacitor on Android (`androidScheme: https`)
 */
export const NATIVE_SESSION_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'capacitor://localhost',
  'https://localhost',
] as const;

/** Default custom-scheme URL an OAuth sign-in returns a native shell to. */
export const DEFAULT_NATIVE_OAUTH_REDIRECT = 'tropis://auth/callback';
