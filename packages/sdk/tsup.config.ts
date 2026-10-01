import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // @tropis/shared is a private workspace package, so the published SDK
  // carries the catalog, header names and event types inside its JS bundle.
  // The declarations still import its types: publishing needs @tropis/shared
  // published too, or its types inlined.
  noExternal: ['@tropis/shared'],
});
