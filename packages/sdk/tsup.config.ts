import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // @tropis/shared is a private workspace package: the published SDK carries
  // what it uses from it inside both the JS bundle (noExternal) and the
  // declarations (dts.resolve), so dist/ never imports it.
  dts: {
    resolve: ['@tropis/shared'],
    compilerOptions: {
      baseUrl: '.',
      paths: { '@tropis/shared': ['../shared/src/index.ts'] },
    },
  },
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  noExternal: ['@tropis/shared'],
});
