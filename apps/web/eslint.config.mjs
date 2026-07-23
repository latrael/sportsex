// ESLint 9 flat config. Replaces .eslintrc.json, which ESLint 9 no longer reads
// (eslint-config-next 16 ships flat configs only).
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'prisma/migrations/**',
      'coverage/**',
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
