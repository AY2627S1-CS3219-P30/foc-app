import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.release-results/**',
      // web-app has its own bun toolchain and its own eslint config.
      'web-app/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['error'] }],
    },
  },
  {
    // The load scripts run in k6, not Node (TST-03): k6's globals, and the summary they print.
    files: ['load/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
  {
    // load/live.mjs runs in Node 22 beside them (N1.4, #332): the globals it uses, and its summary.
    files: ['load/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'AbortController',
          'TextDecoder',
          'console',
          'fetch',
          'performance',
          'process',
          'setTimeout',
        ].map((name) => [name, 'readonly']),
      ),
    },
    rules: { 'no-console': 'off' },
  },
  {
    // Tests may reach for `any` and log freely.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-console': 'off' },
  },
);
