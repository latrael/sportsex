// R1.5 — backfill the full 25/26 season from the community archive (Vaastav's
// Fantasy-Premier-League dataset) through the same plan/sync pipeline the live
// API uses. The FPL API rolled over to 26/27 on 2026-07-23, so 25/26 is no
// longer fetchable from FPL directly; this replays it from the archived CSVs.
//
//   ARCHIVE_DIR=/path/to/data/2025-26 DATABASE_URL=... npx tsx src/scripts/backfill-2526.ts
//
// The directory must hold teams.csv, players_raw.csv, fixtures.csv and
// gws/gw1.csv … gws/gw38.csv. Idempotent: a second run reports zero changes.
/* eslint-disable no-console -- a CLI backfill script; console is its output */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import {
  buildBootstrapPayload,
  buildEventLivePlan,
  buildFixturesPayload,
  parseCsv,
  planBootstrap,
  planFixtures,
  syncBootstrap,
  syncEventLive,
  syncFixtures,
  type SyncCounts,
} from '@/lib/ingest';
import { parseBootstrapStatic, parseFixtures } from '@/lib/fpl';

const SEASON = { name: '2025/26', startYear: 2025 };
const GAMEWEEKS = 38;

function readCsv(dir: string, ...parts: string[]) {
  return parseCsv(readFileSync(join(dir, ...parts), 'utf8'));
}

function addCounts(a: SyncCounts, b: SyncCounts): SyncCounts {
  return {
    created: a.created + b.created,
    updated: a.updated + b.updated,
    unchanged: a.unchanged + b.unchanged,
  };
}

async function main() {
  const dir = process.env.ARCHIVE_DIR;
  if (!dir) throw new Error('set ARCHIVE_DIR to the archive season directory');

  const db = new PrismaClient();
  const startedAt = Date.now();
  try {
    // ---- reference: bootstrap-static → clubs, players, gameweeks
    const teams = readCsv(dir, 'teams.csv');
    const players = readCsv(dir, 'players_raw.csv');
    const fixtures = readCsv(dir, 'fixtures.csv');
    const gwNumbers = [...new Set(fixtures.map((f) => Number(f.event)).filter(Number.isFinite))];

    const bootstrap = parseBootstrapStatic(buildBootstrapPayload(teams, players, gwNumbers));
    const bootstrapResult = await syncBootstrap(db, planBootstrap(bootstrap, { season: SEASON }));
    console.log(
      `bootstrap: clubs ${fmt(bootstrapResult.clubSeasons)}, players ${fmt(bootstrapResult.playerSeasons)}, gameweeks ${fmt(bootstrapResult.gameweeks)}`,
    );

    // ---- fixtures
    const fixturesResult = await syncFixtures(
      db,
      planFixtures(parseFixtures(buildFixturesPayload(fixtures))),
      {
        startYear: SEASON.startYear,
      },
    );
    console.log(
      `fixtures: ${fmt(fixturesResult.fixtures)} (${fixturesResult.unscheduled} unscheduled)`,
    );

    // ---- live: one gameweek at a time
    let fixtureStats: SyncCounts = { created: 0, updated: 0, unchanged: 0 };
    let gameweekStats: SyncCounts = { created: 0, updated: 0, unchanged: 0 };
    let warnings = 0;
    for (let gw = 1; gw <= GAMEWEEKS; gw++) {
      const rows = readCsv(dir, 'gws', `gw${gw}.csv`);
      const plan = buildEventLivePlan(rows);
      const res = await syncEventLive(db, plan, {
        startYear: SEASON.startYear,
        gameweekNumber: gw,
      });
      fixtureStats = addCounts(fixtureStats, res.fixtureStats);
      gameweekStats = addCounts(gameweekStats, res.gameweekStats);
      warnings += res.warnings.length;
      process.stdout.write(
        `  gw${String(gw).padStart(2)}: ${plan.fixtureStats.length} fixture rows, ${plan.gameweekStats.length} players` +
          (res.warnings.length ? ` (${res.warnings.length} warnings)` : '') +
          '\n',
      );
    }

    console.log(
      `\nplayer_fixture_stat: ${fmt(fixtureStats)}\nplayer_gameweek_stat: ${fmt(gameweekStats)}\nwarnings: ${warnings}`,
    );
    console.log(`\ndone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } finally {
    await db.$disconnect();
  }
}

function fmt(c: SyncCounts): string {
  return `${c.created} created / ${c.updated} updated / ${c.unchanged} unchanged`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
