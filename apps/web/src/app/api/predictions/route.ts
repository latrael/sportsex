import { NextResponse } from 'next/server';
import { z } from 'zod';
import { LedgerAccount, LedgerReason, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import {
  getOrInitUserBalanceMinor,
  recordBalancedTransfer,
  syncUserCoinBalanceMirror,
} from '@/lib/market';
import { coinsToMinorUnits } from '@/lib/money';
import { computeFixtureOdds } from '@/lib/predictions/odds';

const schema = z
  .object({
    fixtureId: z.number().int().positive().optional(),
    matchId: z.number().int().positive().optional(),
    pick: z.enum(['H', 'D', 'A']),
    coinsStaked: z.number().int().min(10).max(10000),
    odds: z.number().positive().optional(),
  })
  .refine((d) => d.fixtureId != null || d.matchId != null, {
    message: 'fixtureId or matchId is required',
  });

export async function POST(req: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const { pick, coinsStaked } = parsed.data;
  const fixtureId = (parsed.data.fixtureId ?? parsed.data.matchId)!;

  const fixture = await prisma.fixture.findUnique({
    where: { id: fixtureId },
    include: {
      homeClub: true,
      awayClub: true,
    },
  });
  if (!fixture) return NextResponse.json({ error: 'match_not_found' }, { status: 404 });
  if (fixture.finished || fixture.finishedProvisional) {
    return NextResponse.json({ error: 'match_not_open' }, { status: 400 });
  }

  const existing = await prisma.prediction.findFirst({ where: { userId, fixtureId } });
  if (existing) return NextResponse.json({ error: 'already_predicted' }, { status: 409 });

  const computed = computeFixtureOdds({
    homeStrengthAttack: fixture.homeClub.strengthAttackHome,
    homeStrengthDefence: fixture.homeClub.strengthDefenceHome,
    awayStrengthAttack: fixture.awayClub.strengthAttackAway,
    awayStrengthDefence: fixture.awayClub.strengthDefenceAway,
  });
  const chosenOdds = parsed.data.odds ?? computed.odds[pick];

  const stakeMinor = coinsToMinorUnits(coinsStaked);
  const oddsDec = new Prisma.Decimal(chosenOdds.toFixed(4));

  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('unauthorized');

      const balanceBeforeMinor = await getOrInitUserBalanceMinor(
        tx,
        userId,
        user.coinBalance,
      );
      if (balanceBeforeMinor < stakeMinor) {
        throw new Error('insufficient_funds');
      }

      await tx.prediction.create({
        data: {
          userId,
          fixtureId,
          pick,
          coinsStaked,
          odds: oddsDec,
        },
      });

      await recordBalancedTransfer(tx, [
        {
          userId,
          account: LedgerAccount.USER_CASH,
          reason: LedgerReason.PREDICTION_STAKE,
          amount: -stakeMinor,
        },
        {
          userId: null,
          account: LedgerAccount.AMM_LIQUIDITY,
          reason: LedgerReason.PREDICTION_STAKE,
          amount: stakeMinor,
        },
      ]);

      await syncUserCoinBalanceMirror(tx, userId, balanceBeforeMinor - stakeMinor);
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'internal_error';
    if (code === 'insufficient_funds') {
      return NextResponse.json({ error: 'insufficient_funds' }, { status: 400 });
    }
    throw err;
  }

  return NextResponse.json({
    ok: true,
    pick,
    coinsStaked,
    odds: chosenOdds,
    expectedPayout: Math.round(coinsStaked * chosenOdds),
    fixtureId,
    matchId: fixtureId,
  });
}

export async function GET(req: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);

  const predictions = await prisma.prediction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      fixture: {
        include: {
          homeClub: { include: { club: true } },
          awayClub: { include: { club: true } },
        },
      },
    },
  });

  // Include compatibility shape (`matchId`, `match.home.name`, `match.away.name`) alongside `fixture`
  const shaped = predictions.map((p) => ({
    ...p,
    matchId: p.fixtureId,
    odds: Number(p.odds),
    match: {
      id: p.fixture.id,
      home: { name: p.fixture.homeClub.club.name },
      away: { name: p.fixture.awayClub.club.name },
    },
  }));

  return NextResponse.json(shaped);
}
