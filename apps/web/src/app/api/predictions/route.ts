import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';

const schema = z.object({
  matchId: z.number().int().positive(),
  pick: z.enum(['H', 'D', 'A']),
  coinsStaked: z.number().int().min(10).max(10000),
});

export async function POST(req: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const { matchId, pick, coinsStaked } = parsed.data;

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) return NextResponse.json({ error: 'match_not_found' }, { status: 404 });
  if (match.status !== 'scheduled' && match.status !== 'live') {
    return NextResponse.json({ error: 'match_not_open' }, { status: 400 });
  }

  const existing = await prisma.prediction.findFirst({ where: { userId, matchId } });
  if (existing) return NextResponse.json({ error: 'already_predicted' }, { status: 409 });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.coinBalance < coinsStaked) {
    return NextResponse.json({ error: 'insufficient_funds' }, { status: 400 });
  }

  await prisma.$transaction([
    prisma.prediction.create({ data: { userId, matchId, pick, coinsStaked } }),
    prisma.user.update({ where: { id: userId }, data: { coinBalance: { decrement: coinsStaked } } }),
    prisma.transaction.create({
      data: {
        userId,
        assetKind: 'prediction_payout',
        assetId: matchId,
        side: 'debit',
        coinsDelta: -coinsStaked,
        reason: `prediction_stake_match_${matchId}`,
      },
    }),
  ]);

  return NextResponse.json({ ok: true, pick, coinsStaked });
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
      match: {
        include: { home: { select: { name: true } }, away: { select: { name: true } } },
      },
    },
  });

  return NextResponse.json(predictions);
}
