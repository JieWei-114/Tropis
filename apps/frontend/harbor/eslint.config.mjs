import { FlatCompat } from '@eslint/eslintrc';

// `next lint` is removed in Next.js 16, so this app is linted by the ESLint
// flat-config CLI (`eslint .`) like apps/frontend/helm. FlatCompat is still
// needed because eslint-config-next only ships eslintrc-style shareables.
const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  { ignores: ['.next', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  // Flat config lints only *.js by default; widen it to the app's real sources.
  { files: ['**/*.{js,mjs,cjs,ts,tsx}'] },
];

export default config;
