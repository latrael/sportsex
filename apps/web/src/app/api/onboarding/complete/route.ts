import { NextResponse } from 'next/server';
import { z } from 'zod';
import { LedgerReason } from '@prisma/client';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { mintToUser } from '@/lib/market';
import { coinsToMinorUnits } from '@/lib/money';

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

  const uniquePlayerIds = Array.from(new Set(playerIds));
  if (uniquePlayerIds.length !== 3) {
    return NextResponse.json({ error: 'invalid_players' }, { status: 400 });
  }

  const quest = await prisma.quest.findUnique({ where: { code: 'onboarding_picks' } });
  if (!quest) return NextResponse.json({ error: 'quest_not_found' }, { status: 500 });

  const alreadyDone = await prisma.userQuest.findFirst({
    where: { userId, questId: quest.id },
  });
  if (alreadyDone) return NextResponse.json({ error: 'already_completed' }, { status: 409 });

  const players = await prisma.player.findMany({ where: { id: { in: uniquePlayerIds } } });
  if (players.length !== 3) return NextResponse.json({ error: 'invalid_players' }, { status: 400 });

  await prisma.$transaction(async (tx) => {
    await tx.userQuest.create({ data: { userId, questId: quest.id } });
    await mintToUser(tx, {
      userId,
      amountMinor: coinsToMinorUnits(REWARD),
      reason: LedgerReason.QUEST_REWARD,
    });
  });

  return NextResponse.json({ ok: true, coinsGranted: REWARD });
}
