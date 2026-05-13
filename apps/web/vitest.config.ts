import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    globalSetup: './src/test/globalSetup.ts',
    setupFiles: ['./src/test/setup.ts'],
    // SQLite cannot handle concurrent writes: run test files one at a time.
    fileParallelism: false,
    env: {
      DATABASE_URL: 'file:./prisma/test.db',
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
