// patch-minutes.ts — backfill estimated minutes for players where minutes=0 but appearances>0.
// Uses appearances * 75 as a reasonable EPL average minutes-per-game estimate.
// Run from apps/web: npx tsx --env-file=.env src/jobs/patch-minutes.ts

import { PrismaClient } from '@prisma/client';
import { seedPrice } from '../lib/pricing';

const prisma = new PrismaClient();

async function main() {
  const players = await prisma.player.findMany({
    where: { minutes: 0, appearances: { gt: 0 } },
    include: { valuations: { orderBy: { computedAt: 'desc' }, take: 1 } },
  });

  console.log(`Patching ${players.length} player(s) with estimated minutes…`);

  for (const p of players) {
    const estimatedMinutes = p.appearances * 75;
    const newPrice = seedPrice({ goals: p.goals, assists: p.assists, minutes: estimatedMinutes });

    await prisma.player.update({
      where: { id: p.id },
      data: { minutes: estimatedMinutes },
    });

    // Only update base price if the player hasn't been actively traded (no demand drift)
    const latestValuation = p.valuations[0];
    if (latestValuation) {
      await prisma.valuation.create({
        data: {
          playerId: p.id,
          price: newPrice,
          basePrice: newPrice,
          demandMult: latestValuation.demandMult,
        },
      });
    }
  }

  console.log('Done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
