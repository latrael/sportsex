import { PrismaClient } from '@prisma/client';
import { recomputeSeasonStats } from '../src/lib/derive';
import { syncSeasonFairValues } from '../src/lib/valuation';

const prisma = new PrismaClient();

const QUESTS = [
  {
    code: 'login_today',
    title: 'Daily Login',
    body: 'Sign in today.',
    rewardCoins: 100,
    repeatKind: 'daily',
  },
  {
    code: 'place_one_trade',
    title: 'Make a Move',
    body: 'Place one buy or sell order today.',
    rewardCoins: 200,
    repeatKind: 'daily',
  },
  {
    code: 'comment_on_player',
    title: 'Hot Take',
    body: 'Post a comment on any player.',
    rewardCoins: 150,
    repeatKind: 'daily',
  },
  {
    code: 'onboarding_picks',
    title: 'First Picks',
    body: 'Buy shares in 3 different players.',
    rewardCoins: 500,
    repeatKind: 'one_shot',
  },
];

async function main() {
  console.log('Seeding quests…');
  for (const q of QUESTS) {
    await prisma.quest.upsert({
      where: { code: q.code },
      update: {
        title: q.title,
        body: q.body,
        rewardCoins: q.rewardCoins,
        repeatKind: q.repeatKind,
      },
      create: q,
    });
  }

  const latestSeason = await prisma.season.findFirst({ orderBy: { startYear: 'desc' } });
  if (latestSeason) {
    console.log(`Recomputing season stats for ${latestSeason.name}…`);
    await recomputeSeasonStats(prisma, { startYear: latestSeason.startYear });
    console.log(`Syncing 38-gameweek fair values & price ticks for ${latestSeason.name}…`);
    const res = await syncSeasonFairValues(prisma, { startYear: latestSeason.startYear });
    console.log(
      `Synced ${res.assetsCreated} new assets, ${res.fairValuesWritten} fair values, ${res.priceTicksWritten} price ticks.`,
    );
  }

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
