// R2.3's second accept, as a test rather than a promise: **no `increment:`
// anywhere in the stats path.**
//
// v1 accumulated season totals in place (`appearances: { increment: 1 }` in
// cron/sync-stats and admin/simulate-match), which is why it needed
// recalc-stats.ts, patch-minutes.ts and reset-for-resync.ts to repair the drift
// that followed — a re-ingest double-counted, a failed run half-counted, and
// nothing could tell you which. The v2 rule is that every aggregate is a
// recompute from immutable event rows, so this scan fails the build if an
// atomic increment ever reappears in the ingest, derive or job code.
//
// Scoped to the v2 engine room on purpose. The v1 routes above still contain
// increments and still pass CI; R2.5 deletes them. Coin balances are a separate
// concern with a separate rule — the double-entry ledger (R4.2) — and are not in
// scope here.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const STATS_PATH_DIRS = ['src/lib/ingest', 'src/lib/derive', 'src/scripts'];

/** Prisma's atomic update payload: `{ increment: n }`. */
const ATOMIC_UPDATE = /\{\s*(increment|decrement|multiply|divide)\s*:/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('the stats path never increments', () => {
  it('has no atomic Prisma increment in ingest, derive or scripts', () => {
    const offenders: string[] = [];
    for (const dir of STATS_PATH_DIRS) {
      for (const file of tsFilesUnder(dir)) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (ATOMIC_UPDATE.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is actually scanning files', () => {
    // A guard that greps nothing passes forever.
    const files = STATS_PATH_DIRS.flatMap(tsFilesUnder);
    expect(files.length).toBeGreaterThan(10);
  });
});
