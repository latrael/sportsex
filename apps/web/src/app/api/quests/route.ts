import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function GET() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const today = startOfToday();

  const [quests, completions, tradesToday, commentsToday] = await Promise.all([
    prisma.quest.findMany({ orderBy: { id: 'asc' } }),
    prisma.userQuest.findMany({ where: { userId } }),
    prisma.transaction.findFirst({
      where: { userId, side: { in: ['buy', 'sell'] }, createdAt: { gte: today } },
    }),
    prisma.comment.findFirst({ where: { userId, createdAt: { gte: today } } }),
  ]);

  const completedTodayIds = new Set(
    completions.filter((c) => c.completedAt >= today).map((c) => c.questId),
  );
  const completedEverIds = new Set(completions.map((c) => c.questId));

  const result = quests.map((q) => {
    const completedToday = completedTodayIds.has(q.id);
    const completedEver = completedEverIds.has(q.id);

    let canClaim = false;
    if (q.code === 'onboarding_picks') {
      canClaim = false;
    } else if (q.repeatKind === 'one_shot') {
      canClaim = !completedEver;
    } else {
      // daily — eligible if not claimed today
      if (!completedToday) {
        if (q.code === 'login_today') canClaim = true;
        if (q.code === 'place_one_trade') canClaim = !!tradesToday;
        if (q.code === 'comment_on_player') canClaim = !!commentsToday;
      }
    }

    return { ...q, completedToday, completedEver, canClaim };
  });

  return NextResponse.json(result);
}
