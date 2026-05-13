import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import PredictionsClient from './PredictionsClient';

export const dynamic = 'force-dynamic';

export default async function PredictionsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const [me, scheduledMatches, myPredictions] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.match.findMany({
      where: { status: { in: ['scheduled', 'live'] } },
      orderBy: { kickoffAt: 'asc' },
      include: {
        home: { select: { id: true, name: true } },
        away: { select: { id: true, name: true } },
      },
    }),
    prisma.prediction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        match: {
          include: {
            home: { select: { name: true } },
            away: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  const myPredictionMatchIds = new Set(myPredictions.map((p) => p.matchId));

  const matches = scheduledMatches.map((m) => ({
    id: m.id,
    homeTeam: m.home.name,
    awayTeam: m.away.name,
    kickoffAt: m.kickoffAt.toISOString(),
    status: m.status,
    alreadyPredicted: myPredictionMatchIds.has(m.id),
  }));

  const predictions = myPredictions.map((p) => ({
    id: p.id,
    matchId: p.matchId,
    homeTeam: p.match.home.name,
    awayTeam: p.match.away.name,
    pick: p.pick,
    coinsStaked: p.coinsStaked,
    resolved: p.resolved,
    payout: p.payout,
    createdAt: p.createdAt.toISOString(),
  }));

  return (
    <PredictionsClient
      balance={me?.coinBalance ?? 0}
      matches={matches}
      predictions={predictions}
    />
  );
}
