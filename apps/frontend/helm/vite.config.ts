/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['vite.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Tropis',
        short_name: 'Tropis',
        description: 'Tropis — full-stack playground dashboard',
        theme_color: '#13131f',
        background_color: '#0b0b14',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // Offline app shell: precache all built assets…
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        // …but never serve stale API data: network-first with a short timeout.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 },
            },
          },
        ],
        // SPA navigation fallback must never swallow API routes.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  build: {
    // Let Vite/Rollup decide chunking — it splits vendor code safely and
    // preserves React's load order. (A hand-rolled manualChunks that isolated
    // React broke it at runtime: "Cannot read 'createContext' of undefined".)
    // The >500 kB warning is cosmetic; raise the threshold rather than risk a
    // broken split. A properly tested split can be revisited later.
    chunkSizeWarningLimit: 900,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Consume @tropis/shared from TypeScript source — its published entry is CJS
      // (__exportStar re-exports) which Rollup can't statically analyse.
      '@tropis/shared': fileURLToPath(
        new URL('../../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'dist/', 'vite.config.ts'],
    },
  },
});
