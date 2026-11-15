import { NextResponse } from 'next/server';
import { z } from 'zod';
import { LedgerReason } from '@prisma/client';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { executeAmmOrder, mintToUser } from '@/lib/market';
import { coinsToMinorUnits } from '@/lib/money';

const schema = z.object({
  playerIds: z.array(z.number().int().positive()).length(3),
  /** When true, automatically buys 1 starter share in each of the 3 picked players. */
  buyStarterShares: z.boolean().optional(),
  /** When true, strictly requires existing positions (`shares > 0`) in all 3 picked players. */
  requirePositions: z.boolean().optional(),
});

const REWARD = 500;

export async function POST(req: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const { playerIds, buyStarterShares, requirePositions } = parsed.data;

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

  const players = await prisma.player.findMany({
    where: { id: { in: uniquePlayerIds } },
    include: {
      seasons: {
        orderBy: { seasonId: 'desc' },
        take: 1,
        include: {
          asset: {
            include: {
              fairValues: { take: 1 },
            },
          },
        },
      },
    },
  });
  if (players.length !== 3) return NextResponse.json({ error: 'invalid_players' }, { status: 400 });

  // R7.2 — Verify or purchase starter positions on the 3 picked players
  const pricedAssets = players
    .map((p) => p.seasons[0]?.asset)
    .filter((a): a is NonNullable<typeof a> => a != null && a.fairValues.length > 0);

  if (buyStarterShares && pricedAssets.length === 3) {
    for (const asset of pricedAssets) {
      await executeAmmOrder(prisma, {
        userId,
        v2AssetId: asset.id,
        side: 'BUY',
        shares: 1,
      });
    }
  } else if (requirePositions || pricedAssets.length === 3) {
    const heldPositions = await prisma.position.findMany({
      where: {
        userId,
        shares: { gt: 0 },
        asset: {
          playerSeason: {
            playerId: { in: uniquePlayerIds },
          },
        },
      },
      select: {
        asset: {
          select: {
            playerSeason: { select: { playerId: true } },
          },
        },
      },
    });
    const heldPlayerIds = new Set(
      heldPositions
        .map((pos) => pos.asset.playerSeason?.playerId)
        .filter((id): id is number => id != null),
    );
    if (heldPlayerIds.size < 3) {
      return NextResponse.json({ error: 'positions_not_held' }, { status: 400 });
    }
  }

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
