import { NextResponse } from 'next/server';
import { z } from 'zod';
import { LedgerReason } from '@prisma/client';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { mintToUser } from '@/lib/market';
import { coinsToMinorUnits } from '@/lib/money';

const schema = z.object({ code: z.string() });

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function POST(req: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const { code } = parsed.data;

  if (code === 'onboarding_picks') {
    return NextResponse.json({ error: 'use_onboarding_flow' }, { status: 400 });
  }

  const quest = await prisma.quest.findUnique({ where: { code } });
  if (!quest) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const today = startOfToday();

  if (quest.repeatKind === 'one_shot') {
    const done = await prisma.userQuest.findFirst({ where: { userId, questId: quest.id } });
    if (done) return NextResponse.json({ error: 'already_completed' }, { status: 409 });
  } else {
    const recent = await prisma.userQuest.findFirst({
      where: { userId, questId: quest.id, completedAt: { gte: today } },
    });
    if (recent) return NextResponse.json({ error: 'already_claimed_today' }, { status: 409 });
  }

  if (code === 'place_one_trade') {
    const trade = await prisma.trade.findFirst({
      where: { userId, createdAt: { gte: today } },
    });
    if (!trade) return NextResponse.json({ error: 'no_trade_today' }, { status: 400 });
  }

  if (code === 'comment_on_player') {
    const comment = await prisma.comment.findFirst({
      where: { userId, status: 'visible', createdAt: { gte: today } },
    });
    if (!comment) return NextResponse.json({ error: 'no_comment_today' }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.userQuest.create({ data: { userId, questId: quest.id } });
    if (code === 'login_today') {
      await tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    }
    await mintToUser(tx, {
      userId,
      amountMinor: coinsToMinorUnits(quest.rewardCoins),
      reason: LedgerReason.QUEST_REWARD,
    });
  });

  return NextResponse.json({ ok: true, coinsGranted: quest.rewardCoins });
}
