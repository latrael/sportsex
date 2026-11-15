// R3.6 & R3.7 — Backtest harness & calibration verification over the full 25/26 season.
//
// Replays gameweeks 1..38 against the stored 25/26 database, dumps price
// distributions at GW1 / GW10 / GW20 / GW38, verifies all R3.1/R3.7 acceptance
// criteria (position z-score mean ≈ 0 / sd ≈ 1, all 4 position groups in top 100,
// 5th–95th percentile ratio >= 10x, manual sanity checks), and writes a
// reproducible markdown report (`BACKTEST_2526.md` by default).
//
//   DATABASE_URL=... npx tsx src/scripts/backtest-2526.ts [--out=../../BACKTEST_2526.md]
/* eslint-disable no-console -- CLI backtest script */

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient, type PlayerPosition } from '@prisma/client';
import {
  evaluateLeagueAtGameweek,
  scorePerformanceCohort,
  type EvaluatedPlayerValuation,
  type PerformanceStatInput,
  type PlayerValuationMetadata,
} from '@/lib/valuation';

const CHECKPOINT_GWS = [1, 10, 20, 38] as const;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

async function main() {
  const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  const outPath = resolve(process.cwd(), outArg ?? '../../BACKTEST_2526.md');

  const db = new PrismaClient();
  try {
    const season = await db.season.findUnique({ where: { startYear: 2025 } });
    if (!season) {
      throw new Error('Season 2025/26 not found in database. Run backfill-2526.ts first.');
    }

    const playerSeasons = await db.playerSeason.findMany({
      where: { seasonId: season.id },
      include: {
        player: true,
        clubSeason: { include: { club: true } },
      },
      orderBy: { id: 'asc' },
    });

    const gwRows = await db.playerGameweekStat.findMany({
      where: { gameweek: { seasonId: season.id } },
      include: {
        gameweek: { select: { number: true } },
        playerSeason: { select: { position: true } },
      },
      orderBy: [{ gameweek: { number: 'asc' } }, { playerSeasonId: 'asc' }],
    });

    const players: PlayerValuationMetadata[] = playerSeasons.map((ps) => ({
      playerSeasonId: ps.id,
      fplId: ps.fplId,
      webName: ps.player.webName,
      firstName: ps.player.firstName,
      secondName: ps.player.secondName,
      clubSeasonId: ps.clubSeasonId,
      clubShortName: ps.clubSeason.club.shortName,
      position: ps.position,
      status: ps.status,
      chanceOfPlayingNextRound: ps.chanceOfPlayingNextRound,
      nowCost: ps.nowCost,
    }));

    const stats: (PerformanceStatInput & { starts: number })[] = gwRows.map((r) => ({
      playerSeasonId: r.playerSeasonId,
      gameweekNumber: r.gameweek.number,
      position: r.playerSeason.position,
      minutes: r.minutes,
      starts: r.starts,
      goalsScored: r.goalsScored,
      assists: r.assists,
      cleanSheets: r.cleanSheets,
      goalsConceded: r.goalsConceded,
      ownGoals: r.ownGoals,
      penaltiesSaved: r.penaltiesSaved,
      penaltiesMissed: r.penaltiesMissed,
      yellowCards: r.yellowCards,
      redCards: r.redCards,
      saves: r.saves,
      bonus: r.bonus,
      tackles: r.tackles,
      recoveries: r.recoveries,
      clearancesBlocksInterceptions: r.clearancesBlocksInterceptions,
      defensiveContribution: r.defensiveContribution,
      expectedGoals: r.expectedGoals.toString(),
      expectedAssists: r.expectedAssists.toString(),
      expectedGoalsConceded: r.expectedGoalsConceded.toString(),
      threat: r.threat.toString(),
      creativity: r.creativity.toString(),
    }));

    // R3.1 Check: Cohort z-score distribution across all 25/26 active appearances
    const fullCohort = scorePerformanceCohort(stats);
    const positions: PlayerPosition[] = ['GKP', 'DEF', 'MID', 'FWD'];
    const zStatsByPos: Record<PlayerPosition, { count: number; mean: number; sd: number }> = {
      GKP: { count: 0, mean: 0, sd: 0 },
      DEF: { count: 0, mean: 0, sd: 0 },
      MID: { count: 0, mean: 0, sd: 0 },
      FWD: { count: 0, mean: 0, sd: 0 },
    };

    for (const pos of positions) {
      const activeZ = fullCohort.scores
        .filter((s) => s.position === pos && s.minutes > 0)
        .map((s) => s.zScore);
      const mean = activeZ.reduce((a, b) => a + b, 0) / activeZ.length;
      const variance = activeZ.reduce((a, z) => a + (z - mean) ** 2, 0) / activeZ.length;
      zStatsByPos[pos] = { count: activeZ.length, mean, sd: Math.sqrt(variance) };
    }

    // Replay all 38 gameweeks
    const snapshots = new Map<number, EvaluatedPlayerValuation[]>();
    for (let gw = 1; gw <= 38; gw++) {
      // At GW38 we apply the end-of-season snapshot status; at earlier GWs we let
      // observed minutes drive availability so mid-season snapshots reflect what was known then.
      const evals = evaluateLeagueAtGameweek({
        players,
        gameweekStatsUpToTarget: stats,
        targetGameweek: gw,
        useSnapshotStatus: gw === 38,
      });
      snapshots.set(gw, evals);
    }

    const gw38 = snapshots.get(38)!;
    const sortedGw38Desc = [...gw38].sort((a, b) => b.value - a.value);
    const sortedGw38Asc = [...gw38].map((p) => p.value).sort((a, b) => a - b);

    const p5 = percentile(sortedGw38Asc, 5);
    const p50 = percentile(sortedGw38Asc, 50);
    const p95 = percentile(sortedGw38Asc, 95);
    const p95ToP5Ratio = p95 / p5;

    // Top 100 position distribution at GW38
    const top100 = sortedGw38Desc.slice(0, 100);
    const top100ByPos: Record<PlayerPosition, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of top100) {
      top100ByPos[p.position] += 1;
    }

    // Also compute GW20 (mid-season, pure minutes availability) distribution
    const gw20 = snapshots.get(20)!;
    const sortedGw20Desc = [...gw20].sort((a, b) => b.value - a.value);
    const sortedGw20Asc = [...gw20].map((p) => p.value).sort((a, b) => a - b);
    const gw20P5 = percentile(sortedGw20Asc, 5);
    const gw20P95 = percentile(sortedGw20Asc, 95);
    const gw20Ratio = gw20P95 / gw20P5;
    const gw20Top100ByPos: Record<PlayerPosition, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of sortedGw20Desc.slice(0, 100)) {
      gw20Top100ByPos[p.position] += 1;
    }

    const lines: string[] = [];
    lines.push('# sportsex — 2025/26 Valuation Engine Backtest Report (R3.6 / R3.7)');
    lines.push('');
    lines.push(
      'Generated deterministically from the 2025/26 backfilled season (`npx tsx src/scripts/backtest-2526.ts`).',
    );
    lines.push('');
    lines.push('## 1. Position Cohort Z-Score Verification (R3.1)');
    lines.push('');
    lines.push('| Position | Active Appearances (`minutes > 0`) | Z-Score Mean | Z-Score SD | Raw Mean | Raw SD |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const pos of positions) {
      const z = zStatsByPos[pos];
      const c = fullCohort.cohorts[pos];
      lines.push(
        `| **${pos}** | ${z.count} | ${z.mean.toFixed(6)} | ${z.sd.toFixed(6)} | ${c.mean.toFixed(4)} | ${c.sd.toFixed(4)} |`,
      );
    }
    lines.push('');
    lines.push('## 2. Price Distribution Checkpoints (GW1 / GW10 / GW20 / GW38)');
    lines.push('');
    lines.push(
      '| Gameweek | Min | P5 | P25 | Median (P50) | Mean | P75 | P95 | Max | P95 / P5 Ratio | Top 100 (GKP / DEF / MID / FWD) |',
    );
    lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');

    for (const gw of CHECKPOINT_GWS) {
      const list = snapshots.get(gw)!;
      const asc = list.map((x) => x.value).sort((a, b) => a - b);
      const desc = [...list].sort((a, b) => b.value - a.value);
      const mean = asc.reduce((a, b) => a + b, 0) / asc.length;
      const cP5 = percentile(asc, 5);
      const cP25 = percentile(asc, 25);
      const cP50 = percentile(asc, 50);
      const cP75 = percentile(asc, 75);
      const cP95 = percentile(asc, 95);
      const ratio = cP95 / cP5;
      const posCounts: Record<PlayerPosition, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
      for (const p of desc.slice(0, 100)) posCounts[p.position] += 1;

      lines.push(
        `| **GW${gw}** | ${asc[0].toFixed(2)} | ${cP5.toFixed(2)} | ${cP25.toFixed(2)} | ${cP50.toFixed(2)} | ${mean.toFixed(2)} | ${cP75.toFixed(2)} | ${cP95.toFixed(2)} | ${asc[asc.length - 1].toFixed(2)} | **${ratio.toFixed(2)}x** | ${posCounts.GKP} / ${posCounts.DEF} / ${posCounts.MID} / ${posCounts.FWD} |`,
      );
    }

    lines.push('');
    lines.push('## 3. Top 25 Players at GW38');
    lines.push('');
    lines.push(
      '| Rank | Player | Club | Pos | Fair Value (V) | Baseline (B) | Form (F) | Avail (M) | Minutes | Starts |',
    );
    lines.push('|---:|---|---|---|---:|---:|---:|---:|---:|---:|');
    sortedGw38Desc.slice(0, 25).forEach((p, idx) => {
      lines.push(
        `| ${idx + 1} | **${p.webName}** (${p.fullName}) | ${p.clubShortName} | ${p.position} | **${p.value.toFixed(2)}** | ${p.baseline.toFixed(3)} | ${p.form.toFixed(3)} | ${p.availabilityMult.toFixed(3)} | ${p.minutes} | ${p.starts} |`,
      );
    });

    lines.push('');
    lines.push('## 4. Top 5 Per Position Group at GW38');
    lines.push('');
    for (const pos of positions) {
      lines.push(`### ${pos}`);
      lines.push('| Rank | Player | Club | Fair Value (V) | Baseline (B) | Form (F) | Avail (M) | Minutes |');
      lines.push('|---:|---|---|---:|---:|---:|---:|---:|');
      sortedGw38Desc
        .filter((p) => p.position === pos)
        .slice(0, 5)
        .forEach((p, idx) => {
          lines.push(
            `| ${idx + 1} | **${p.webName}** | ${p.clubShortName} | **${p.value.toFixed(2)}** | ${p.baseline.toFixed(3)} | ${p.form.toFixed(3)} | ${p.availabilityMult.toFixed(3)} | ${p.minutes} |`,
          );
        });
      lines.push('');
    }

    lines.push('## 5. Acceptance Gate Summary (R3.7)');
    lines.push('');
    const allPosInTop100 = positions.every((pos) => top100ByPos[pos] > 0);
    const ratioPass = p95ToP5Ratio >= 10;
    const zPass = positions.every(
      (pos) => Math.abs(zStatsByPos[pos].mean) < 1e-6 && Math.abs(zStatsByPos[pos].sd - 1) < 1e-6,
    );

    lines.push(`- **Z-score standardisation (R3.1)**: ${zPass ? 'PASS' : 'FAIL'} (mean = 0, sd = 1 for all 4 position cohorts)`);
    lines.push(
      `- **All 4 position groups in Top 100 (GW38)**: ${allPosInTop100 ? 'PASS' : 'FAIL'} (GKP=${top100ByPos.GKP}, DEF=${top100ByPos.DEF}, MID=${top100ByPos.MID}, FWD=${top100ByPos.FWD})`,
    );
    lines.push(
      `- **All 4 position groups in Top 100 (GW20)**: GKP=${gw20Top100ByPos.GKP}, DEF=${gw20Top100ByPos.DEF}, MID=${gw20Top100ByPos.MID}, FWD=${gw20Top100ByPos.FWD}`,
    );
    lines.push(
      `- **5th–95th percentile price ratio >= 10x**: ${ratioPass ? 'PASS' : 'FAIL'} (GW38 P95/P5 = ${p95ToP5Ratio.toFixed(2)}x [P5=${p5.toFixed(2)}, P50=${p50.toFixed(2)}, P95=${p95.toFixed(2)}]; GW20 P95/P5 = ${gw20Ratio.toFixed(2)}x)`,
    );

    const report = lines.join('\n') + '\n';
    writeFileSync(outPath, report, 'utf8');
    console.log(report);
    console.log(`Wrote report to ${outPath}`);

    if (!allPosInTop100 || !ratioPass || !zPass) {
      process.exitCode = 1;
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
