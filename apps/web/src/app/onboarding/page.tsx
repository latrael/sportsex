import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { latestPricesByPlayerIds } from '@/lib/queries';
import OnboardingPicker from './OnboardingPicker';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const quest = await prisma.quest.findUnique({ where: { code: 'onboarding_picks' } });
  if (quest) {
    const done = await prisma.userQuest.findFirst({ where: { userId, questId: quest.id } });
    if (done) redirect('/');
  }

  const players = await prisma.player.findMany({
    take: 24,
    orderBy: [{ goals: 'desc' }, { assists: 'desc' }],
    include: { team: true },
  });

  const priceMap = await latestPricesByPlayerIds(players.map((p) => p.id));

  const playerData = players.map((p) => ({
    id: p.id,
    fullName: p.fullName,
    posBucket: p.posBucket,
    teamName: p.team?.name ?? '—',
    goals: p.goals,
    assists: p.assists,
    price: priceMap.get(p.id) ?? 50,
  }));

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="card">
        <h1 className="text-2xl font-bold mb-1">Welcome to sportsex!</h1>
        <p className="text-mute text-sm">
          Pick 3 players you believe in. You&apos;ll earn <span className="text-accent font-semibold">+500 bonus coins</span> to kick off your portfolio.
        </p>
      </div>

      <OnboardingPicker players={playerData} />
    </div>
  );
}
