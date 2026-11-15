import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getOrInitUserBalanceMinor } from '@/lib/market';
import { minorUnitsToCoinsDecimal } from '@/lib/money';
import { computeFixtureOdds } from '@/lib/predictions/odds';
import PredictionsClient from './PredictionsClient';

export const dynamic = 'force-dynamic';

export default async function PredictionsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const [me, openFixtures, myPredictions] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.fixture.findMany({
      where: { finished: false },
      orderBy: { kickoffTime: 'asc' },
      take: 40,
      include: {
        homeClub: { include: { club: true } },
        awayClub: { include: { club: true } },
      },
    }),
    prisma.prediction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        fixture: {
          include: {
            homeClub: { include: { club: true } },
            awayClub: { include: { club: true } },
          },
        },
      },
    }),
  ]);

  const balanceMinor = me
    ? await getOrInitUserBalanceMinor(prisma, userId, me.coinBalance)
    : 0n;
  const balanceCoins = Math.floor(Number(minorUnitsToCoinsDecimal(balanceMinor)));

  const myPredictionFixtureIds = new Set(myPredictions.map((p) => p.fixtureId));

  const matches = openFixtures.map((f) => {
    const quoted = computeFixtureOdds({
      homeStrengthAttack: f.homeClub.strengthAttackHome,
      homeStrengthDefence: f.homeClub.strengthDefenceHome,
      awayStrengthAttack: f.awayClub.strengthAttackAway,
      awayStrengthDefence: f.awayClub.strengthDefenceAway,
    });
    return {
      id: f.id,
      homeTeam: f.homeClub.club.name,
      awayTeam: f.awayClub.club.name,
      kickoffAt: (f.kickoffTime ?? new Date()).toISOString(),
      status: f.started ? 'live' : 'scheduled',
      alreadyPredicted: myPredictionFixtureIds.has(f.id),
      odds: quoted.odds,
    };
  });

  const predictions = myPredictions.map((p) => ({
    id: p.id,
    matchId: p.fixtureId,
    homeTeam: p.fixture.homeClub.club.name,
    awayTeam: p.fixture.awayClub.club.name,
    pick: p.pick,
    coinsStaked: p.coinsStaked,
    odds: Number(p.odds),
    resolved: p.resolved,
    payout: p.payout,
    createdAt: p.createdAt.toISOString(),
  }));

  return (
    <PredictionsClient
      balance={balanceCoins}
      matches={matches}
      predictions={predictions}
    />
  );
}
