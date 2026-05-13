import { execSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';

const TEST_DB = resolve(__dirname, '../../prisma/test.db');

export function setup() {
  execSync('pnpm exec prisma db push --force-reset --skip-generate', {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
    stdio: 'pipe',
  });
}

export function teardown() {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}
