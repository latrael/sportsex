import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { checkOrderCooldown, recordOrderCooldown } from '@/lib/cooldown';
import { executeAmmOrder } from '@/lib/market';

const schema = z.object({
  assetKind: z.enum(['player', 'team']),
  assetId: z.number().int().positive(),
  side: z.enum(['buy', 'sell']),
  shares: z.number().int().min(1).max(2000),
});

export async function POST(req: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const { assetKind, assetId, side, shares } = parsed.data;

  const now = Date.now();
  const cd = await checkOrderCooldown(prisma, userId, now);
  if (!cd.allowed) {
    return NextResponse.json({ error: 'cooldown' }, { status: 429 });
  }
  recordOrderCooldown(userId, now);

  try {
    const result = await executeAmmOrder(prisma, {
      userId,
      assetKind,
      assetId,
      side,
      shares,
    });

    return NextResponse.json({
      ok: true,
      tradeId: result.tradeId,
      assetId: result.assetId,
      price: result.price,
      spotPriceAfter: result.spotPriceAfter,
      priceImpactPct: result.quote.priceImpactPct,
      grossCostMinor: result.quote.grossCostMinor.toString(),
      feeMinor: result.quote.feeMinor.toString(),
      totalUserCashMinor: result.quote.totalUserCashMinor.toString(),
      coinsDeltaMinor: result.coinsDeltaMinor.toString(),
      coinsDelta: result.coinsDelta,
      balanceMinor: result.balanceAfterMinor.toString(),
      balance: result.balanceAfterCoins,
    });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === 'unauthorized' ? 401 : msg === 'no_price' ? 500 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
