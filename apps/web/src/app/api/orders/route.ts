import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { latestPrice, netBuys24hForPlayer } from '@/lib/queries';
import { livePrice, demandMultiplier } from '@/lib/pricing';
import { lastOrderAt } from '@/lib/cooldown';

const schema = z.object({
  assetKind: z.enum(['player', 'team']),
  assetId: z.number().int().positive(),
  side: z.enum(['buy', 'sell']),
  shares: z.number().int().min(1).max(1000),
});

// Per-user cooldown (see @/lib/cooldown for the shared map)
const COOLDOWN_MS = 1000;
const MAX_FLOAT_PCT = 0.05;
const MAX_POSITION_PER_ASSET = 2000;

export async function POST(req: Request) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const { assetKind, assetId, side, shares } = parsed.data;

  const now = Date.now();
  const last = lastOrderAt.get(userId) ?? 0;
  if (now - last < COOLDOWN_MS) return NextResponse.json({ error: 'cooldown' }, { status: 429 });
  lastOrderAt.set(userId, now);

  // Current price
  const price = await latestPrice(assetKind, assetId);
  if (!Number.isFinite(price) || price <= 0) return NextResponse.json({ error: 'no_price' }, { status: 500 });

  // Snapshot demand BEFORE the trade so the price tick doesn't include
  // this user's own buy/sell — prevents the instant round-trip profit glitch.
  const preTradeDemand = assetKind === 'player' ? await netBuys24hForPlayer(assetId) : 0;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('no_user');

      if (assetKind === 'player') {
        const p = await tx.player.findUnique({ where: { id: assetId } });
        if (!p) throw new Error('no_asset');
        if (side === 'buy') {
          const floatLeft = p.totalShares - p.sharesHeld;
          if (shares > floatLeft) throw new Error('insufficient_float');
          if (shares > Math.ceil(p.totalShares * MAX_FLOAT_PCT)) throw new Error('max_float_pct');
        }
      } else {
        // teams: synthesize a soft float
        if (side === 'buy' && shares > 200) throw new Error('max_float_pct');
      }

      const totalCoins = Math.round(price * shares);
      if (side === 'buy' && user.coinBalance < totalCoins) throw new Error('insufficient_funds');

      const existing = await tx.holding.findFirst({
        where: { userId, assetKind, assetId },
      });

      if (side === 'sell') {
        if (!existing || existing.shares < shares) throw new Error('insufficient_shares');
      }

      // Update holding
      if (side === 'buy') {
        if (existing) {
          const newShares = existing.shares + shares;
          const newAvg = (existing.avgCost * existing.shares + price * shares) / newShares;
          if (newShares > MAX_POSITION_PER_ASSET) throw new Error('position_cap');
          await tx.holding.update({ where: { id: existing.id }, data: { shares: newShares, avgCost: newAvg } });
        } else {
          if (shares > MAX_POSITION_PER_ASSET) throw new Error('position_cap');
          await tx.holding.create({ data: { userId, assetKind, assetId, shares, avgCost: price } });
        }
      } else {
        const newShares = existing!.shares - shares;
        if (newShares === 0) {
          await tx.holding.delete({ where: { id: existing!.id } });
        } else {
          await tx.holding.update({ where: { id: existing!.id }, data: { shares: newShares } });
        }
      }

      // Update user balance
      const coinsDelta = side === 'buy' ? -totalCoins : +totalCoins;
      await tx.user.update({ where: { id: userId }, data: { coinBalance: user.coinBalance + coinsDelta } });

      // Update sharesHeld on the player
      if (assetKind === 'player') {
        await tx.player.update({
          where: { id: assetId },
          data: { sharesHeld: { increment: side === 'buy' ? shares : -shares } },
        });
      }

      // Ledger
      await tx.transaction.create({
        data: {
          userId,
          assetKind,
          assetId,
          side,
          shares,
          price,
          coinsDelta,
          reason: 'market_order',
        },
      });

      return { coinsDelta, totalCoins };
    });

    // Tick price refresh (player only — team prices update post-match)
    if (assetKind === 'player') {
      const last = await prisma.valuation.findFirst({
        where: { playerId: assetId },
        orderBy: { computedAt: 'desc' },
      });
      const base = last?.basePrice ?? price;
      const mult = demandMultiplier(preTradeDemand);
      const newPrice = livePrice(base, preTradeDemand);
      await prisma.valuation.create({
        data: {
          playerId: assetId,
          price: newPrice,
          basePrice: base,
          demandMult: mult,
        },
      });
    }

    return NextResponse.json({ ok: true, price, coinsDelta: result.coinsDelta });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === 'unauthorized' ? 401 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
