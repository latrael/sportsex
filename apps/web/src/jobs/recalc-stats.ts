// recalc-stats.ts — recomputes Player season totals from PlayerMatchStat records.
// Run once after syncing to clear out the stale seeded values from last year.
// Run from apps/web: npx tsx --env-file=.env src/jobs/recalc-stats.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Recomputing player season totals from match stats…');

  const agg = await prisma.playerMatchStat.groupBy({
    by: ['playerId'],
    _sum: { goals: true, assists: true, minutes: true },
    _count: { id: true },
  });

  console.log(`Found match stats for ${agg.length} player(s).`);

  // Update players who have match data
  for (const row of agg) {
    await prisma.player.update({
      where: { id: row.playerId },
      data: {
        goals: row._sum.goals ?? 0,
        assists: row._sum.assists ?? 0,
        minutes: row._sum.minutes ?? 0,
        appearances: row._count.id,
      },
    });
  }

  // Zero out players with no match data at all (e.g. injured all season)
  const withStats = new Set(agg.map((r) => r.playerId));
  const allPlayers = await prisma.player.findMany({ select: { id: true } });
  const noStatIds = allPlayers.map((p) => p.id).filter((id) => !withStats.has(id));

  if (noStatIds.length > 0) {
    await prisma.player.updateMany({
      where: { id: { in: noStatIds } },
      data: { goals: 0, assists: 0, minutes: 0, appearances: 0 },
    });
    console.log(`Zeroed out ${noStatIds.length} player(s) with no match appearances.`);
  }

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
