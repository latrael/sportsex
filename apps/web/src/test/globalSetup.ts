import { execSync } from 'child_process';
import { resolve } from 'path';
import { TEST_DATABASE_URL } from './testDatabaseUrl';

const WEB_ROOT = resolve(__dirname, '../..');

/**
 * Guard against `--force-reset` ever pointing at a real database.
 *
 * `prisma db push --force-reset` drops every table. apps/web/.env holds the
 * production Neon URL, so a stray DATABASE_URL here would wipe production.
 * Only a Postgres database on localhost whose name ends in `_test` is allowed.
 */
function assertDisposable(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${url}`);
  }

  const isPostgres = parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:';
  const isLocal = ['localhost', '127.0.0.1', '::1', 'postgres'].includes(parsed.hostname);
  const isTestDb = parsed.pathname.replace(/^\//, '').endsWith('_test');

  if (!isPostgres || !isLocal || !isTestDb) {
    throw new Error(
      'Refusing to reset a database that does not look disposable.\n' +
        `  host: ${parsed.hostname}  db: ${parsed.pathname.replace(/^\//, '')}\n` +
        'TEST_DATABASE_URL must be a postgres:// URL on localhost with a database name ending in "_test".\n' +
        'Run `docker compose up -d` from the repo root to start one.',
    );
  }
}

export function setup() {
  const url = TEST_DATABASE_URL;
  assertDisposable(url);

  try {
    execSync('pnpm exec prisma db push --force-reset --skip-generate', {
      cwd: WEB_ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    const detail = (err.stderr?.toString() || err.stdout?.toString() || '').trim();
    throw new Error(
      `Could not prepare the test database at ${url}\n\n${detail}\n\n` +
        'Is Postgres running? From the repo root: docker compose up -d',
    );
  }
}

export function teardown() {
  // Nothing to clean up: the database is disposable and setup() resets it.
}
