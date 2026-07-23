/**
 * Single source of truth for the test database URL.
 *
 * Imported by both vitest.config.ts (to inject DATABASE_URL into test files)
 * and globalSetup.ts (which runs in the main vitest process, where `test.env`
 * has not been applied yet).
 *
 * Local default matches docker-compose.yml at the repo root. CI overrides it
 * with the postgres service container (see .github/workflows/ci.yml).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/sportsex_test';
