/**
 * Where a native shell keeps its refresh token: OS secure storage (iOS
 * Keychain, Android Keystore, the desktop OS keyring), supplied by the app.
 * The browser console never uses one; its refresh token is the httpOnly
 * cookie.
 */
export interface SecureTokenStore {
  /** The stored refresh token, or null when there is none. */
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}
