import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor native shell config (Android/iOS).
 *
 * API endpoints: the shells load the *built* web app from `dist/`, so all
 * endpoints are baked in at `pnpm build` time from Vite env vars (see
 * src/lib/env.ts and apps/frontend/helm/.env). For device testing, VITE_*
 * URLs must point at a backend reachable from the device, e.g. your
 * machine's LAN IP, not localhost. See docs/deployment.md#build-time-endpoints.
 *
 * Scheme: the Android WebView serves the app from https://localhost
 * (androidScheme 'https'), because WebCrypto (the OAuth PKCE challenge) and
 * the service worker exist only in a secure context. An https page may not
 * call plain-http endpoints, and Android blocks cleartext traffic, so:
 * - with https endpoints (a TLS tunnel or a trusted local certificate) no
 *   flag is needed;
 * - for http LAN endpoints during development, run `cap sync` with
 *   CAP_DEV_HTTP=1, which allows mixed content and cleartext traffic. Never
 *   ship a build synced that way.
 *
 * Sessions: the refresh token lives in the Keychain / Android Keystore
 * (@aparajita/capacitor-secure-storage), and OAuth returns through the
 * `tropis://auth/callback` deep link registered in AndroidManifest.xml and
 * Info.plist (CFBundleURLTypes). See docs/deployment.md#native-sessions.
 */
const devHttp = process.env.CAP_DEV_HTTP === '1';

const config: CapacitorConfig = {
  // Placeholder — replace with your real reverse-DNS app id before shipping.
  appId: 'dev.tropis.app',
  appName: 'Tropis',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: devHttp,
  },
  android: {
    allowMixedContent: devHttp,
  },
};

export default config;
