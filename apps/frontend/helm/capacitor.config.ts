import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor native shell config (Android/iOS).
 *
 * IMPORTANT — API endpoints: the shells load the *built* web app from `dist/`,
 * so all endpoints are baked in at `pnpm build` time from Vite env vars
 * (see src/lib/env.ts and apps/frontend/helm/.env). For device testing, VITE_*
 * URLs must point at a backend reachable from the device — e.g. your
 * machine's LAN IP (http://192.168.x.x:3100), not localhost.
 * See docs/multi-platform.md.
 */
const config: CapacitorConfig = {
  // Placeholder — replace with your real reverse-DNS app id before shipping.
  appId: 'dev.tropis.app',
  appName: 'Tropis',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
