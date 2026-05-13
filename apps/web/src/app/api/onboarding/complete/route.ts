import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';

const schema = z.object({
  playerIds: z.array(z.number().int().positive()).length(3),
});

const REWARD = 500;

export async function POST(req: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const { playerIds } = parsed.data;

  const quest = await prisma.quest.findUnique({ where: { code: 'onboarding_picks' } });
  if (!quest) return NextResponse.json({ error: 'quest_not_found' }, { status: 500 });

  const alreadyDone = await prisma.userQuest.findFirst({
    where: { userId, questId: quest.id },
  });
  if (alreadyDone) return NextResponse.json({ error: 'already_completed' }, { status: 409 });

  const players = await prisma.player.findMany({ where: { id: { in: playerIds } } });
  if (players.length !== 3) return NextResponse.json({ error: 'invalid_players' }, { status: 400 });

  await prisma.$transaction([
    prisma.userQuest.create({ data: { userId, questId: quest.id } }),
    prisma.user.update({ where: { id: userId }, data: { coinBalance: { increment: REWARD } } }),
    prisma.transaction.create({
      data: {
        userId,
        assetKind: 'quest_reward',
        side: 'credit',
        coinsDelta: REWARD,
        reason: 'onboarding_picks',
      },
    }),
  ]);

  return NextResponse.json({ ok: true, coinsGranted: REWARD });
}
