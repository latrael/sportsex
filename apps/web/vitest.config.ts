import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { TEST_DATABASE_URL } from './src/test/testDatabaseUrl';

// The Prisma schema targets postgresql, so tests need a real Postgres.
// Local: `docker compose up -d` at the repo root brings one up on 5433.
// CI: a postgres:16 service container (see .github/workflows/ci.yml).

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    globalSetup: './src/test/globalSetup.ts',
    setupFiles: ['./src/test/setup.ts'],
    // Tests share one database and truncate between files: run them serially.
    fileParallelism: false,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_URL,
      NEXTAUTH_SECRET: 'test-secret-not-for-production',
      ADMIN_TOKEN: 'test-admin-token',
      NODE_ENV: 'test',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/lib/**', 'src/app/api/**'],
      exclude: ['src/app/api/auth/**'],
    },
  },
});
