// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'src/gen/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Type-checked rules — warn so CI stays green while fixes land incrementally
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/unbound-method': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      // Every record goes through the logger (common/observability/logger.ts)
      // so it carries trace ids, redaction and the shared record shape.
      'no-console': 'error',
      // Module code logs through createLogger() with an explicit event name;
      // Nest's Logger and PinoLogger records carry no event.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/common',
              importNames: ['Logger'],
              message: 'Use createLogger() from common/observability/logger.',
            },
            {
              name: 'nestjs-pino',
              importNames: ['PinoLogger', 'InjectPinoLogger'],
              message: 'Use createLogger() from common/observability/logger.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/common/observability/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // One-off CLI scripts print to the terminal.
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
);
