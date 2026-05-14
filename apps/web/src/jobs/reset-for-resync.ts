// reset-for-resync.ts — clears match settlement data so sync-matches can re-run cleanly.
// Safe: keeps seed valuations, teams, players, users, holdings, and trades untouched.
// Run from apps/web: npx tsx --env-file=.env src/jobs/reset-for-resync.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$transaction(async (tx) => {
    // Remove per-match player stats
    const { count: statCount } = await tx.playerMatchStat.deleteMany();
    console.log(`Deleted ${statCount} PlayerMatchStat rows.`);

    // Remove valuations that came from match settlement (keep seed valuations which have no matchId)
    const { count: valCount } = await tx.valuation.deleteMany({
      where: { matchId: { not: null } },
    });
    console.log(`Deleted ${valCount} match-settlement Valuation rows.`);

    // Reset synced matches back to 'finished' so sync-matches will reprocess them
    const { count: matchCount } = await tx.match.updateMany({
      where: { externalId: { not: null } },
      data: { status: 'finished', settledAt: null },
    });
    console.log(`Reset ${matchCount} match(es) to 'finished'.`);

    // Zero out player season stats — sync will rebuild them correctly
    const { count: playerCount } = await tx.player.updateMany({
      data: { goals: 0, assists: 0, minutes: 0, appearances: 0 },
    });
    console.log(`Reset stats for ${playerCount} player(s).`);
  });

  console.log('\nReady. Now run: npx tsx --env-file=.env src/jobs/sync-matches.ts');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
