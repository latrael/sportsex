// R2.3 — recompute `player_season_stat` for a season from the stored event rows.
//
//   DATABASE_URL=... npx tsx src/scripts/recompute-season-stats.ts [startYear]
//   DATABASE_URL=... npx tsx src/scripts/recompute-season-stats.ts 2025 --check
//
// `--check` writes nothing and exits non-zero if the stored aggregates disagree
// with a fresh recompute — invariant 4 as a command. Run it twice without the
// flag and the second run reports 0 created / 0 updated, which is the same
// property observed from the writing side.
/* eslint-disable no-console -- a CLI job; console is its output */

import { PrismaClient } from '@prisma/client';
import { recomputeSeasonStats } from '@/lib/derive';

const DEFAULT_START_YEAR = 2025;

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const yearArg = args.find((a) => !a.startsWith('--'));
  const startYear = yearArg ? Number(yearArg) : DEFAULT_START_YEAR;
  if (!Number.isInteger(startYear)) {
    throw new Error(`startYear must be a year, got ${yearArg}`);
  }

  const db = new PrismaClient();
  const startedAt = Date.now();
  try {
    const result = await recomputeSeasonStats(db, { startYear, check });
    const { created, updated, unchanged } = result.seasonStats;

    console.log(
      `${check ? 'check' : 'recompute'} ${startYear}: ` +
        `${created} ${check ? 'missing' : 'created'} / ${updated} ${check ? 'stale' : 'updated'} / ${unchanged} unchanged ` +
        `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );

    if (result.warnings.length > 0) {
      console.log(`\n${result.warnings.length} cross-grain warnings:`);
      for (const w of result.warnings.slice(0, 20)) console.log(`  ${w}`);
      if (result.warnings.length > 20) console.log(`  (+${result.warnings.length - 20} more)`);
    } else {
      console.log('cross-grain check: per-fixture and per-gameweek sums agree for every player');
    }

    if (check && result.drifted.length > 0) {
      console.error(
        `\nFAIL invariant 4: ${result.drifted.length} players' stored aggregates disagree ` +
          `with the recompute — playerSeasonId ${result.drifted.slice(0, 10).join(', ')}` +
          (result.drifted.length > 10 ? ', …' : ''),
      );
      process.exitCode = 1;
      return;
    }
    if (check) console.log('PASS invariant 4: stored aggregates reproduce exactly');
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
